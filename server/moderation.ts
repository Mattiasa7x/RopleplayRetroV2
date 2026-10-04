import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MOD, SAFETY, SITE_ROOMS, Trust } from '../shared/config.js';
import { assertRoomAccess, canView, roomBySlug, roomRoleOf } from './rooms.js';
import type { RoomSanctionDTO } from '../shared/types.js';
import { HttpError, parse, requireUser, type SessionUser } from './http.js';
import { disconnectUser, removeFromRoom, rooms, type IO } from './realtime.js';
import { reloadBlocklist } from './safety/pipeline.js';
import { audit, db, tx } from './store.js';

async function moderatedRoomIds(userId: string): Promise<number[]> {
  const { rows } = await db.query<{ room_id: number }>('SELECT room_id FROM room_moderators WHERE user_id = $1', [userId]);
  return rows.map((r) => r.room_id);
}

/** Site staff ('admin', 'moderator') or a member room's own team ('owner', 'room_moderator', 'room_operator'). */
type ModRole = 'admin' | 'moderator' | 'owner' | 'room_moderator' | 'room_operator';
const ROOM_TEAM: ModRole[] = ['owner', 'room_moderator', 'room_operator'];
const STAFF_ROLES = new Set<ModRole>(['admin', 'moderator']);

/**
 * Admins moderate everywhere. Site moderators moderate their assigned site rooms and every
 * member room (staff outrank room owners). In a member room, its owner, moderators and
 * operators moderate it. Site-wide actions need an admin.
 */
async function assertCanModerate(u: SessionUser, roomId: number | null): Promise<ModRole> {
  if (u.trust >= Trust.Admin) return 'admin';
  if (roomId != null) {
    const { rows } = await db.query<{ kind: string; owner_id: string | null; role: 'moderator' | 'operator' | null }>(
      `SELECT r.kind, r.owner_id::text AS owner_id, rr.role FROM rooms r
         LEFT JOIN room_roles rr ON rr.room_id = r.id AND rr.user_id = $2 WHERE r.id = $1`, [roomId, u.id]);
    const room = rows[0];
    if (u.trust >= Trust.RoomModerator && (room?.kind === 'member' || (await moderatedRoomIds(u.id)).includes(roomId))) return 'moderator';
    if (room?.kind === 'member') {
      if (room.owner_id === u.id) return 'owner';
      if (room.role === 'moderator') return 'room_moderator';
      if (room.role === 'operator') return 'room_operator';
    }
  }
  throw new HttpError(403, 'not_mod', roomId == null ? 'Only admins can take site-wide action.' : "You don't moderate this room.");
}

async function userByHandle(handle: string) {
  const { rows } = await db.query<{ id: string; handle: string; trust_level: number }>(
    'SELECT id, handle, trust_level FROM users WHERE lower(handle) = lower($1)',
    [handle],
  );
  if (!rows[0]) throw new HttpError(404, 'no_user', 'No one has that handle.');
  return rows[0];
}

const ReportBody = z.object({ messageId: z.string().regex(/^\d{1,19}$/), reason: z.string().trim().min(1).max(300) });
const ContentReportBody = z.object({
  kind: z.enum(['profile', 'photo', 'comment', 'status', 'dm', 'photo_comment', 'gift']),
  id: z.string().regex(/^\d{1,19}$/).optional(),
  handle: z.string().max(16).optional(),
  reason: z.string().trim().min(1).max(300),
});
const ResolveBody = z.object({ status: z.enum(['actioned', 'dismissed']) });
const HideBody = z.object({ reason: z.string().trim().min(1).max(200) });
const SanctionBody = z.object({
  handle: z.string(),
  kind: z.enum(['mute', 'kick', 'ban', 'shadow_mute']),
  room: z.string().optional(), // slug; omit for site-wide (admins only)
  minutes: z.number().int().positive().max(365 * 24 * 60).optional(), // omit = permanent (not allowed for mute)
  reason: z.string().trim().min(1).max(300),
});
const SlowBody = z.object({ seconds: z.number().int().min(0).max(600) });
const ReviewBody = z.object({ decision: z.enum(['clear', 'ban']) });
const ModAssignBody = z.object({ handle: z.string(), room: z.string(), action: z.enum(['add', 'remove']) });

export function registerModerationRoutes(app: FastifyInstance, io: IO) {
  // ---------- reports (any verified user) ----------
  app.post('/api/reports', async (req, reply) => {
    const u = requireUser(req, Trust.Verified);
    const body = parse(ReportBody, req.body);
    const { rows } = await db.query(
      `SELECT m.id, m.room_id, m.user_id, u.handle, m.body, m.created_at, r.slug, r.kind
         FROM messages m JOIN users u ON u.id = m.user_id JOIN rooms r ON r.id = m.room_id
        WHERE m.id = $1 AND NOT m.is_shadow`,
      [body.messageId],
    );
    const m = rows[0];
    if (!m || !(await canView(u, await roomBySlug(m.slug)))) throw new HttpError(404, 'no_message', 'That message is no longer available.');
    if (m.user_id === u.id) throw new HttpError(400, 'self', "You can't report your own message.");

    // Snapshot the line plus the five before it, so moderators see context even after pruning.
    const { rows: context } = await db.query(
      `SELECT m.id, u.handle, m.body, m.created_at FROM messages m JOIN users u ON u.id = m.user_id
        WHERE m.room_id = $1 AND m.id < $2 AND NOT m.is_shadow ORDER BY m.id DESC LIMIT 5`,
      [m.room_id, m.id],
    );
    const snapshot = { message: { id: m.id, handle: m.handle, body: m.body, createdAt: m.created_at, room: m.slug }, context: context.reverse() };

    const ins = await db.query(
      `INSERT INTO reports (reporter_id, target_user_id, room_id, message_id, message_snapshot, reason)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (reporter_id, message_id) DO NOTHING RETURNING id`,
      [u.id, m.user_id, m.room_id, m.id, snapshot, body.reason],
    );
    if (!ins.rowCount) throw new HttpError(409, 'already', 'You already reported this message.');

    // Auto-hide once enough established members agree.
    const { rows: c } = await db.query<{ n: string }>(
      `SELECT count(DISTINCT r.reporter_id) AS n FROM reports r JOIN users u ON u.id = r.reporter_id
        WHERE r.message_id = $1 AND r.status = 'open' AND u.trust_level >= $2`,
      [m.id, Trust.Established],
    );
    // Site rooms are stricter: fewer agreeing reports are needed to pull a line.
    if (Number(c[0].n) >= (m.kind === 'site' ? SITE_ROOMS.autoHideReports : SAFETY.autoHideReports)) {
      const hid = await db.query(
        `UPDATE messages SET hidden_at = now(), hidden_reason = 'Auto-hidden after reports' WHERE id = $1 AND hidden_at IS NULL`,
        [m.id],
      );
      if (hid.rowCount) {
        await audit(db, null, 'auto_hide', 'message', m.id, { reports: Number(c[0].n) });
        io.to(rooms.chat(m.room_id)).emit('msg:hidden', { id: m.id, roomId: m.room_id });
      }
    }
    return reply.status(201).send({ ok: true });
  });

  // ---------- reports on profile content (bio, photos, comments, statuses) ----------
  app.post('/api/reports/content', async (req, reply) => {
    const u = requireUser(req, Trust.Verified);
    const b = parse(ContentReportBody, req.body);
    let target: { user_id: string; handle: string; body: string; created_at: Date; id: string } | undefined;
    if (b.kind === 'profile') {
      const r = await db.query("SELECT id AS user_id, handle, coalesce(bio, '(no bio)') AS body, created_at, id FROM users WHERE lower(handle) = lower($1)", [b.handle ?? '']);
      target = r.rows[0];
    } else if (b.kind === 'photo') {
      const r = await db.query("SELECT p.user_id, u.handle, '/media/' || p.id || '/full' AS body, p.created_at, p.id FROM profile_photos p JOIN users u ON u.id = p.user_id WHERE p.id = $1", [b.id ?? '0']);
      target = r.rows[0];
    } else if (b.kind === 'dm') {
      // Only the person who received a private message can report it.
      const r = await db.query(
        `SELECT m.sender_id AS user_id, u.handle, coalesce(m.body, '(photo)') || CASE WHEN m.photo_id IS NOT NULL THEN ' [photo /media/' || m.photo_id || '/full]' ELSE '' END AS body, m.created_at, m.id
           FROM direct_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1 AND m.recipient_id = $2`,
        [b.id ?? '0', u.id],
      );
      target = r.rows[0];
    } else if (b.kind === 'gift') {
      // Only the person who received a gift can report its message.
      const r = await db.query(
        `SELECT g.sender_id AS user_id, u.handle, '[' || g.gift_key || '] ' || coalesce(g.message, '(no message)') AS body, g.created_at, g.id
           FROM gifts g JOIN users u ON u.id = g.sender_id WHERE g.id = $1 AND g.recipient_id = $2`,
        [b.id ?? '0', u.id],
      );
      target = r.rows[0];
    } else {
      const table = b.kind === 'comment' ? 'profile_comments' : b.kind === 'photo_comment' ? 'photo_comments' : 'statuses';
      const col = b.kind === 'status' ? 'user_id' : 'author_id';
      const r = await db.query(`SELECT t.${col} AS user_id, u.handle, t.body, t.created_at, t.id FROM ${table} t JOIN users u ON u.id = t.${col} WHERE t.id = $1`, [b.id ?? '0']);
      target = r.rows[0];
    }
    if (!target) throw new HttpError(404, 'not_found', 'That is no longer available.');
    if (target.user_id === u.id) throw new HttpError(400, 'self', "You can't report yourself.");
    const snapshot = { message: { id: target.id, handle: target.handle, body: `[${b.kind}] ${target.body}`, createdAt: target.created_at, room: null }, context: [] };
    const dup = await db.query(
      "SELECT 1 FROM reports WHERE reporter_id = $1 AND target_kind = $2 AND target_id = $3 AND status = 'open'",
      [u.id, b.kind, target.id],
    );
    if (dup.rowCount) throw new HttpError(409, 'already', 'You already reported this.');
    await db.query(
      `INSERT INTO reports (reporter_id, target_user_id, room_id, message_id, message_snapshot, reason, target_kind, target_id)
       VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6)`,
      [u.id, target.user_id, snapshot, b.reason, b.kind, target.id],
    );
    return reply.status(201).send({ ok: true });
  });

  // ---------- moderator tools ----------
  app.get<{ Querystring: { status?: string } }>('/api/mod/reports', async (req) => {
    const u = requireUser(req, Trust.RoomModerator);
    const status = ['open', 'actioned', 'dismissed'].includes(req.query.status ?? '') ? req.query.status : 'open';
    const scope = u.trust >= Trust.Admin ? null : await moderatedRoomIds(u.id);
    const { rows } = await db.query(
      `SELECT r.id, r.message_id, r.reason, r.status, r.created_at, r.message_snapshot AS snapshot,
              rep.handle AS reporter, tgt.handle AS target, rm.slug AS room,
              (SELECT count(*) FROM reports r2 WHERE r2.message_id = r.message_id) AS report_count,
              (SELECT hidden_at IS NOT NULL FROM messages WHERE id = r.message_id) AS hidden
         FROM reports r
         JOIN users rep ON rep.id = r.reporter_id
         JOIN users tgt ON tgt.id = r.target_user_id
         LEFT JOIN rooms rm ON rm.id = r.room_id
        WHERE r.status = $1 AND ($2::int[] IS NULL OR r.room_id = ANY($2))
        ORDER BY r.created_at ASC LIMIT 100`,
      [status, scope],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/api/mod/reports/:id/resolve', async (req) => {
    const u = requireUser(req, Trust.RoomModerator);
    const { status } = parse(ResolveBody, req.body);
    const { rows } = await db.query<{ room_id: number | null }>('SELECT room_id FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'no_report', 'Report not found.');
    await assertCanModerate(u, rows[0].room_id);
    await tx(async (q) => {
      await q.query('UPDATE reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1', [req.params.id, status, u.id]);
      await audit(q, u.id, `report_${status}`, 'report', req.params.id);
    });
    return { ok: true };
  });

  for (const hide of [true, false]) {
    app.post<{ Params: { id: string } }>(`/api/mod/messages/:id/${hide ? 'hide' : 'unhide'}`, async (req) => {
      const u = requireUser(req, Trust.Verified);
      const { reason } = hide ? parse(HideBody, req.body) : { reason: null };
      const { rows } = await db.query<{ room_id: number; hidden_at: Date | null; hider_trust: number | null }>(
        `SELECT m.room_id, m.hidden_at, h.trust_level AS hider_trust
           FROM messages m LEFT JOIN users h ON h.id = m.hidden_by WHERE m.id = $1`, [req.params.id]);
      if (!rows[0]) throw new HttpError(404, 'no_message', 'That message has already been pruned.');
      const role = await assertCanModerate(u, rows[0].room_id);
      // A room team can't undo what staff (or the automatic filters) hid.
      if (!hide && rows[0].hidden_at && !STAFF_ROLES.has(role) && (rows[0].hider_trust === null || rows[0].hider_trust >= Trust.RoomModerator)) {
        throw new HttpError(403, 'staff_action', 'Staff hid this message, so only staff can show it again.');
      }
      await tx(async (q) => {
        await q.query(
          hide
            ? 'UPDATE messages SET hidden_at = now(), hidden_by = $2, hidden_reason = $3 WHERE id = $1'
            : 'UPDATE messages SET hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL WHERE id = $1',
          hide ? [req.params.id, u.id, reason] : [req.params.id],
        );
        await audit(q, u.id, hide ? 'hide_message' : 'unhide_message', 'message', req.params.id, { reason });
      });
      if (hide) io.to(rooms.chat(rows[0].room_id)).emit('msg:hidden', { id: req.params.id, roomId: rows[0].room_id });
      return { ok: true };
    });
  }

  app.post('/api/mod/sanctions', async (req, reply) => {
    const u = requireUser(req, Trust.Verified);
    const b = parse(SanctionBody, req.body);
    const room = b.room ? await roomBySlug(b.room) : null;
    const role = await assertCanModerate(u, room?.id ?? null);
    const target = await userByHandle(b.handle);
    if (target.id === u.id) throw new HttpError(400, 'self', "You can't sanction yourself.");
    const team = ROOM_TEAM.includes(role);
    if (team && room) {
      // The room's own team: kick, mute or ban from this room only; never site staff; no shadow-mutes.
      // Owner > moderators > operators: the owner can't be touched by their team, and operators
      // can only act on regular members.
      if (b.kind === 'shadow_mute') throw new HttpError(403, 'owner_kind', 'The room team can kick, mute or ban from this room.');
      if (target.trust_level >= Trust.RoomModerator) throw new HttpError(403, 'rank', "The room team can't act on RoleplayRetro staff.");
      const targetRole = await roomRoleOf(room, target.id);
      if (targetRole === 'owner') throw new HttpError(403, 'rank', "The room's owner can't be kicked, muted or banned from their own room.");
      if (role === 'room_operator' && targetRole) throw new HttpError(403, 'rank', 'Operators can only act on regular members.');
    } else if (target.trust_level >= u.trust) {
      throw new HttpError(403, 'rank', 'You can only act on members below your own level.');
    }
    if (b.kind === 'kick' && !room) throw new HttpError(400, 'kick_room', 'A kick needs a room.');

    let minutes: number | null = b.minutes ?? null;
    if (b.kind === 'kick') minutes = MOD.kickMinutes;
    if (b.kind === 'mute') minutes = Math.min(MOD.muteMaxMinutes, Math.max(MOD.muteMinMinutes, minutes ?? 60));

    const id = await tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO sanctions (user_id, kind, room_id, reason, issued_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(mins => $6::int) END)
         RETURNING id`,
        [target.id, b.kind, room?.id ?? null, b.reason, u.id, minutes],
      );
      if (b.kind !== 'kick' && !team) {
        // Trust is lost on staff sanctions (a room owner's decision about their own room doesn't affect site trust): back to Verified at most (staff excluded above).
        await q.query('UPDATE users SET trust_level = LEAST(trust_level, $2) WHERE id = $1', [target.id, Trust.Verified]);
      }
      if (b.kind === 'ban' && !room) await q.query('DELETE FROM sessions WHERE user_id = $1', [target.id]);
      await audit(q, u.id, `sanction_${b.kind}`, 'user', target.id, { room: room?.slug ?? null, minutes, reason: b.reason, sanctionId: rows[0].id });
      return rows[0].id;
    });

    if (room && (b.kind === 'kick' || b.kind === 'ban')) await removeFromRoom(io, target.id, room.id, b.reason, minutes ?? 0);
    if (!room && b.kind === 'ban') disconnectUser(io, target.id);
    if (b.kind === 'mute') io.to(rooms.user(target.id)).emit('notice', { message: `You have been muted for ${minutes} minutes. Reason: ${b.reason}` });
    // shadow_mute: deliberately no notice.
    return reply.status(201).send({ ok: true, id });
  });

  app.post<{ Params: { id: string } }>('/api/mod/sanctions/:id/revoke', async (req) => {
    const u = requireUser(req, Trust.Verified);
    const { rows } = await db.query<{ room_id: number | null; user_id: string; issued_by: string | null; issuer_trust: number | null }>(
      `SELECT s.room_id, s.user_id::text AS user_id, s.issued_by::text AS issued_by, i.trust_level AS issuer_trust
         FROM sanctions s LEFT JOIN users i ON i.id = s.issued_by WHERE s.id = $1 AND s.revoked_at IS NULL`,
      [req.params.id],
    );
    if (!rows[0]) throw new HttpError(404, 'no_sanction', 'No active sanction with that id.');
    if (rows[0].user_id === u.id && u.trust < Trust.Admin) throw new HttpError(403, 'own_sanction', "You can't lift a ban or mute on yourself.");
    const role = await assertCanModerate(u, rows[0].room_id);
    // Staff and automatic actions stand unless staff lift them; a site moderator can't overrule the admin.
    const staffIssued = rows[0].issued_by === null || (rows[0].issuer_trust ?? 0) >= Trust.RoomModerator;
    if (!STAFF_ROLES.has(role) && staffIssued && rows[0].issued_by !== u.id) {
      throw new HttpError(403, 'staff_action', 'Staff gave this ban or mute, so only staff can lift it.');
    }
    if (role === 'moderator' && (rows[0].issuer_trust ?? 0) >= Trust.Admin) {
      throw new HttpError(403, 'staff_action', 'The admin gave this ban or mute, so only the admin can lift it.');
    }
    if (role === 'room_operator' && rows[0].issued_by !== u.id) {
      throw new HttpError(403, 'not_yours', 'Operators can only lift the bans and mutes they gave.');
    }
    await tx(async (q) => {
      await q.query('UPDATE sanctions SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [req.params.id, u.id]);
      await audit(q, u.id, 'revoke_sanction', 'sanction', req.params.id, { userId: rows[0].user_id });
    });
    return { ok: true };
  });

  /** A room's active kicks, mutes and bans, for its team (and staff). */
  app.get<{ Params: { slug: string } }>('/api/rooms/:slug/sanctions', async (req): Promise<RoomSanctionDTO[]> => {
    const u = requireUser(req, Trust.Verified);
    const room = await roomBySlug(req.params.slug);
    await assertRoomAccess(u, room);
    await assertCanModerate(u, room.id);
    const { rows } = await db.query<{ id: string; handle: string; kind: 'mute' | 'kick' | 'ban'; reason: string; issued_by: string | null; created_at: Date; expires_at: Date | null }>(
      `SELECT s.id::text AS id, t.handle, s.kind, s.reason, iu.handle AS issued_by, s.created_at, s.expires_at
         FROM sanctions s JOIN users t ON t.id = s.user_id LEFT JOIN users iu ON iu.id = s.issued_by
        WHERE s.room_id = $1 AND s.revoked_at IS NULL AND s.kind IN ('mute', 'kick', 'ban')
          AND (s.expires_at IS NULL OR s.expires_at > now())
        ORDER BY s.created_at DESC LIMIT 100`, [room.id]);
    return rows.map((r) => ({ id: r.id, handle: r.handle, kind: r.kind, reason: r.reason, issuedBy: r.issued_by,
      createdAt: r.created_at.toISOString(), expiresAt: r.expires_at?.toISOString() ?? null }));
  });

  app.get<{ Params: { handle: string } }>('/api/mod/users/:handle', async (req) => {
    requireUser(req, Trust.RoomModerator);
    const t = await userByHandle(req.params.handle);
    const [{ rows: info }, { rows: sanctions }] = await Promise.all([
      db.query('SELECT handle, trust_level, created_at, message_count, needs_review, email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1', [t.id]),
      db.query(
        `SELECT s.id, s.kind, r.slug AS room, s.reason, s.created_at, s.expires_at, s.revoked_at, iu.handle AS issued_by
           FROM sanctions s LEFT JOIN rooms r ON r.id = s.room_id LEFT JOIN users iu ON iu.id = s.issued_by
          WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 50`,
        [t.id],
      ),
    ]);
    return { user: info[0], sanctions };
  });

  app.post<{ Params: { slug: string } }>('/api/mod/rooms/:slug/slow-mode', async (req) => {
    const u = requireUser(req, Trust.Verified);
    const { seconds } = parse(SlowBody, req.body);
    const room = await roomBySlug(req.params.slug);
    await assertCanModerate(u, room.id);
    await db.query('UPDATE rooms SET slow_mode_seconds = $2 WHERE id = $1', [room.id, seconds]);
    await audit(db, u.id, 'slow_mode', 'room', room.id, { seconds });
    io.to(rooms.chat(room.id)).emit('notice', { message: seconds ? `Slow mode is on: one message every ${seconds} seconds.` : 'Slow mode is off.' });
    return { ok: true };
  });

  // ---------- admin ----------
  app.get('/api/mod/review', async (req) => {
    requireUser(req, Trust.Admin);
    const { rows } = await db.query(
      `SELECT u.handle, u.created_at, u.message_count,
              (SELECT a.detail->>'matchedUserId' FROM audit_log a
                WHERE a.target_type = 'user' AND a.target_id = u.id::text
                  AND a.action IN ('auto_shadow_mute', 'flag_shared_signals')
                ORDER BY a.id DESC LIMIT 1) AS matched_user_id
         FROM users u WHERE u.needs_review ORDER BY u.created_at LIMIT 100`,
    );
    for (const r of rows) {
      if (!r.matched_user_id) continue;
      const m = await db.query('SELECT handle FROM users WHERE id = $1', [r.matched_user_id]);
      r.matched_handle = m.rows[0]?.handle ?? null;
    }
    return rows;
  });

  app.post<{ Params: { handle: string } }>('/api/mod/review/:handle', async (req) => {
    const u = requireUser(req, Trust.Admin);
    const { decision } = parse(ReviewBody, req.body);
    const t = await userByHandle(req.params.handle);
    await tx(async (q) => {
      await q.query('UPDATE users SET needs_review = false WHERE id = $1', [t.id]);
      if (decision === 'clear') {
        await q.query(
          `UPDATE sanctions SET revoked_at = now(), revoked_by = $2
            WHERE user_id = $1 AND kind = 'shadow_mute' AND issued_by IS NULL AND revoked_at IS NULL`,
          [t.id, u.id],
        );
      } else {
        await q.query(`INSERT INTO sanctions (user_id, kind, room_id, reason, issued_by) VALUES ($1, 'ban', NULL, 'Ban evasion', $2)`, [t.id, u.id]);
        await q.query('DELETE FROM sessions WHERE user_id = $1', [t.id]);
      }
      await audit(q, u.id, `review_${decision}`, 'user', t.id);
    });
    if (decision === 'ban') disconnectUser(io, t.id);
    return { ok: true };
  });

  app.get<{ Querystring: { before?: string } }>('/api/mod/audit', async (req) => {
    requireUser(req, Trust.Admin);
    const before = /^\d{1,19}$/.test(req.query.before ?? '') ? req.query.before : null;
    const { rows } = await db.query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at, u.handle AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT 50`,
      [before],
    );
    return rows;
  });

  app.post('/api/admin/moderators', async (req) => {
    const u = requireUser(req, Trust.Admin);
    const b = parse(ModAssignBody, req.body);
    const t = await userByHandle(b.handle);
    const room = await roomBySlug(b.room);
    await tx(async (q) => {
      if (b.action === 'add') {
        await q.query('INSERT INTO room_moderators (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [room.id, t.id]);
        await q.query('UPDATE users SET trust_level = GREATEST(trust_level, $2) WHERE id = $1', [t.id, Trust.RoomModerator]);
      } else {
        await q.query('DELETE FROM room_moderators WHERE room_id = $1 AND user_id = $2', [room.id, t.id]);
        await q.query(
          `UPDATE users SET trust_level = $2 WHERE id = $1 AND trust_level = $3
             AND NOT EXISTS (SELECT 1 FROM room_moderators WHERE user_id = $1)`,
          [t.id, Trust.Established, Trust.RoomModerator],
        );
      }
      await audit(q, u.id, `moderator_${b.action}`, 'user', t.id, { room: room.slug });
    });
    return { ok: true };
  });

  app.post('/api/admin/blocklist/reload', async (req) => {
    const u = requireUser(req, Trust.Admin);
    const entries = reloadBlocklist();
    await audit(db, u.id, 'blocklist_reload', 'system', 'blocklist', { entries });
    return { ok: true, entries };
  });
}
