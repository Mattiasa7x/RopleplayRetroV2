import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Trust } from '../shared/config.js';
import { userByHandle } from './friends.js';
import { clientSignals, HttpError, parse, requireUser } from './http.js';
import { disconnectUser, rooms, type IO } from './realtime.js';
import { exactIpHash, hashedSignals, recordSignals, signalHash } from './safety/signals.js';
import { banMessage } from './safety/pipeline.js';
import { audit, db, redis, tx } from './store.js';

/**
 * Admin powers, for when automatic moderation misses something. Deliberately narrow:
 * the admin sees what members have flagged (never anyone's private messages unless one
 * was reported to them), can delete a single message or post, and can ban a member,
 * optionally blocking the connection and devices they used.
 */

// ---------------- device and address blocks ----------------

/** Blocked address/device hashes → the ban reason shown to them (and when it ends, if ever). */
let blocked = new Map<string, { reason: string; expiresAt: Date | null }>();

export async function loadBlocks() {
  const { rows } = await db.query<{ signal_hash: string; reason: string | null; expires_at: Date | null }>(
    `SELECT b.signal_hash, s.reason, s.expires_at FROM site_blocks b
       LEFT JOIN LATERAL (SELECT reason, expires_at FROM sanctions s
                           WHERE s.user_id = b.user_id AND s.room_id IS NULL AND s.kind = 'ban' AND s.revoked_at IS NULL
                           ORDER BY s.created_at DESC LIMIT 1) s ON true`);
  blocked = new Map(rows.map((r) => [r.signal_hash, { reason: r.reason ?? 'Breaking the Terms of Service', expiresAt: r.expires_at }]));
}

/** Hashes for this request's exact address and device ids. */
function requestHashes(req: FastifyRequest): string[] {
  const s = clientSignals(req);
  const out = [exactIpHash(s.ip)];
  for (const id of [s.deviceCookie, s.clientStorageId]) {
    if (id && /^[A-Za-z0-9_-]{16,64}$/.test(id)) out.push(signalHash('device', id));
  }
  return out;
}

/** The ban that blocks this request's address or device, if any. */
function blockFor(req: FastifyRequest): { reason: string; expiresAt: Date | null } | null {
  if (!blocked.size) return null;
  for (const hash of requestHashes(req)) {
    const b = blocked.get(hash);
    if (b && (!b.expiresAt || b.expiresAt.getTime() > Date.now())) return b;
  }
  return null;
}

export function isBlockedRequest(req: FastifyRequest): boolean {
  return blockFor(req) !== null;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The whole-page "you're banned" screen (uses the site's own stylesheet; no scripts). */
function bannedPage(ban: { reason: string; expiresAt: Date | null }): string {
  const end = ban.expiresAt ? `<p class="banned-when">The ban ends ${esc(ban.expiresAt.toUTCString())}.</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Banned · RoleplayRetro</title><link rel="stylesheet" href="/styles.css"><meta name="robots" content="noindex"></head>
<body class="banned-body"><main class="banned-card"><img src="/logo-mark.svg" alt="" width="64" height="59">
<h1>You're banned from RoleplayRetro</h1>
<p class="banned-reason"><strong>Reason:</strong> ${esc(ban.reason)}</p>${end}
<p class="banned-help">Think this is a mistake? Email <a href="mailto:support@roleplayretro.com">support@roleplayretro.com</a>.</p>
<p class="banned-links"><a href="/terms">Terms of Service</a></p></main></body></html>`;
}

/**
 * Runs on every request: refuse blocked addresses and devices, and note the address a
 * signed-in member is using (at most hourly) so a ban can include it.
 */
export async function blockAndRecord(req: FastifyRequest, reply: FastifyReply) {
  const ban = blockFor(req);
  if (ban) {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') || path.startsWith('/socket.io')) {
      return reply.status(403).send({ error: 'banned', message: banMessage(ban) });
    }
    // Pages (and the Terms) get the banned screen; its stylesheet and logo still load.
    if (!/\.(css|js|svg|png|webmanifest|woff2)$/.test(path) && !/^\/(terms|privacy)\/?$/.test(path)) {
      reply.header('Cache-Control', 'no-store');
      return reply.status(403).type('text/html; charset=utf-8').send(bannedPage(ban));
    }
  }
  if (req.user && (await redis.set(`sig:${req.user.id}`, '1', 'EX', 3600, 'NX')) === 'OK') {
    await recordSignals(db, req.user.id, clientSignals(req)).catch(() => {});
  }
}

/** Socket connections from blocked addresses or devices are refused too. */
export function socketBlocked(headers: Record<string, string | string[] | undefined>, ip: string): boolean {
  if (!blocked.size) return false;
  const cookie = String(headers.cookie ?? '');
  const did = /(?:^|;\s*)did=([A-Za-z0-9_-]{16,64})/.exec(cookie)?.[1];
  const hashes = hashedSignals({ ip, deviceCookie: did }).filter((x) => x.kind !== 'ip_prefix').map((x) => x.hash);
  return hashes.some((h) => { const b = blocked.get(h); return !!b && (!b.expiresAt || b.expiresAt.getTime() > Date.now()); });
}

// ---------------- routes ----------------

const KINDS = ['message', 'dm', 'comment', 'photo_comment', 'status', 'photo', 'gift'] as const;
const DeleteBody = z.object({ kind: z.enum(KINDS), id: z.string().regex(/^\d{1,19}$/) });
const BanBody = z.object({
  handle: z.string().min(1).max(32),
  reason: z.string().trim().min(3).max(300),
  /** Also block the addresses and devices this member used in the last 30 days. */
  blockConnection: z.boolean().default(true),
});

const TABLE: Record<(typeof KINDS)[number], { table: string; author: string }> = {
  message: { table: 'messages', author: 'user_id' },
  dm: { table: 'direct_messages', author: 'sender_id' },
  comment: { table: 'profile_comments', author: 'author_id' },
  photo_comment: { table: 'photo_comments', author: 'author_id' },
  status: { table: 'statuses', author: 'user_id' },
  photo: { table: 'profile_photos', author: 'user_id' },
  gift: { table: 'gifts', author: 'sender_id' },
};

export function registerAdminRoutes(app: FastifyInstance, io: IO) {
  /** Everything members have flagged and nobody has dealt with yet, oldest first. */
  app.get('/api/admin/flagged', async (req) => {
    requireUser(req, Trust.Admin);
    const { rows } = await db.query(
      `SELECT r.id, r.target_kind AS kind, COALESCE(r.target_id, r.message_id)::text AS target_id, r.reason, r.created_at,
              r.message_snapshot AS snapshot, rep.handle AS reporter, tgt.handle AS target, rm.slug AS room,
              (SELECT count(*) FROM reports r2 WHERE r2.status = 'open' AND r2.target_kind = r.target_kind
                  AND COALESCE(r2.target_id, r2.message_id) = COALESCE(r.target_id, r.message_id))::int AS report_count,
              EXISTS (SELECT 1 FROM sanctions s WHERE s.user_id = r.target_user_id AND s.room_id IS NULL AND s.kind = 'ban'
                        AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())) AS target_banned
         FROM reports r
         JOIN users rep ON rep.id = r.reporter_id
         JOIN users tgt ON tgt.id = r.target_user_id
         LEFT JOIN rooms rm ON rm.id = r.room_id
        WHERE r.status = 'open'
        ORDER BY r.created_at ASC LIMIT 200`,
    );
    return rows;
  });

  /** Delete one message or post for good. Any open reports about it are closed as dealt with. */
  app.post('/api/admin/delete', async (req) => {
    const u = requireUser(req, Trust.Admin);
    const b = parse(DeleteBody, req.body);
    const t = TABLE[b.kind];
    const gone = await tx(async (q) => {
      const { rows } = await q.query<{ author: string; room_id?: number }>(
        `DELETE FROM ${t.table} WHERE id = $1 RETURNING ${t.author}::text AS author${b.kind === 'message' ? ', room_id' : ''}`,
        [b.id],
      );
      await q.query(
        `UPDATE reports SET status = 'actioned', resolved_by = $3, resolved_at = now()
          WHERE status = 'open' AND target_kind = $1 AND COALESCE(target_id, message_id) = $2::bigint`,
        [b.kind, b.id, u.id],
      );
      await audit(q, u.id, 'admin_delete', b.kind, b.id, { author: rows[0]?.author ?? null });
      return rows[0];
    });
    if (gone?.room_id != null) io.to(rooms.chat(gone.room_id)).emit('msg:hidden', { id: b.id, roomId: gone.room_id });
    return { ok: true, existed: !!gone };
  });

  app.post<{ Params: { id: string } }>('/api/admin/reports/:id/dismiss', async (req) => {
    const u = requireUser(req, Trust.Admin);
    const { rowCount } = await db.query(
      `UPDATE reports SET status = 'dismissed', resolved_by = $2, resolved_at = now() WHERE id = $1 AND status = 'open'`,
      [req.params.id, u.id],
    );
    if (!rowCount) throw new HttpError(404, 'no_report', 'That report was already handled.');
    await audit(db, u.id, 'report_dismissed', 'report', req.params.id);
    return { ok: true };
  });

  /** Ban from the whole site, and (by default) block the connection and devices they used. */
  app.post('/api/admin/ban', async (req) => {
    const u = requireUser(req, Trust.Admin);
    const b = parse(BanBody, req.body);
    const t = await userByHandle(b.handle);
    if (t.id === u.id) throw new HttpError(400, 'self', "You can't ban yourself.");
    const blockedCount = await tx(async (q) => {
      await q.query(
        `UPDATE sanctions SET revoked_at = now(), revoked_by = $2
          WHERE user_id = $1 AND room_id IS NULL AND kind = 'ban' AND revoked_at IS NULL`,
        [t.id, u.id],
      );
      await q.query(`INSERT INTO sanctions (user_id, kind, room_id, reason, issued_by) VALUES ($1, 'ban', NULL, $2, $3)`, [t.id, b.reason, u.id]);
      await q.query('UPDATE users SET trust_level = LEAST(trust_level, $2) WHERE id = $1', [t.id, Trust.New]);
      await q.query('DELETE FROM sessions WHERE user_id = $1', [t.id]);
      let n = 0;
      if (b.blockConnection) {
        const { rowCount } = await q.query(
          `INSERT INTO site_blocks (signal_hash, kind, user_id, created_by)
           SELECT signal_hash, kind, user_id, $2 FROM device_signals
            WHERE user_id = $1 AND kind IN ('ip', 'device') AND last_seen > now() - interval '30 days'
           ON CONFLICT (signal_hash) DO NOTHING`,
          [t.id, u.id],
        );
        n = rowCount ?? 0;
      }
      await audit(q, u.id, 'admin_ban', 'user', t.id, { reason: b.reason, blockConnection: b.blockConnection, blocked: n });
      return n;
    });
    await loadBlocks();
    disconnectUser(io, t.id);
    return { ok: true, blocked: blockedCount };
  });

  app.get('/api/admin/bans', async (req) => {
    requireUser(req, Trust.Admin);
    const { rows } = await db.query(
      `SELECT u.id, u.handle, s.reason, s.created_at,
              (SELECT count(*) FROM site_blocks b WHERE b.user_id = u.id)::int AS blocked
         FROM sanctions s JOIN users u ON u.id = s.user_id
        WHERE s.room_id IS NULL AND s.kind = 'ban' AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
        ORDER BY s.created_at DESC LIMIT 200`,
    );
    return rows;
  });

  /** Lift a site ban and its connection blocks. */
  app.post<{ Params: { id: string } }>('/api/admin/bans/:id/lift', async (req) => {
    const u = requireUser(req, Trust.Admin);
    await tx(async (q) => {
      await q.query(
        `UPDATE sanctions SET revoked_at = now(), revoked_by = $2
          WHERE user_id = $1 AND room_id IS NULL AND kind = 'ban' AND revoked_at IS NULL`,
        [req.params.id, u.id],
      );
      await q.query('DELETE FROM site_blocks WHERE user_id = $1', [req.params.id]);
      await audit(q, u.id, 'admin_unban', 'user', req.params.id);
    });
    await loadBlocks();
    return { ok: true };
  });
}
