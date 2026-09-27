import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEMBER_ROOMS, Trust } from '../shared/config.js';
import type { RoomDetail } from '../shared/types.js';
import { HttpError, parse, requireUser } from './http.js';
import { removeFromRoom, rooms as sockRooms, type IO } from './realtime.js';
import { accessBlock, activeSanctions, textBlocked } from './safety/pipeline.js';
import { audit, db, tx } from './store.js';

export interface RoomRow {
  id: number;
  slug: string;
  name: string;
  category: string;
  kind: 'site' | 'member';
  owner_id: string | null;
  whitelist_only: boolean;
  description: string | null;
  min_trust_to_post: number;
  slow_mode_seconds: number;
}

export const ROOM_COLS =
  'r.id, r.slug, r.name, r.category, r.kind, r.owner_id, r.whitelist_only, r.description, r.min_trust_to_post, r.slow_mode_seconds';

export interface Viewer {
  id: string;
  trust: number;
}

const NOT_FOUND = 'That room does not exist or is invite-only.';

export async function roomBySlug(slug: string): Promise<RoomRow> {
  const { rows } = await db.query<RoomRow>(`SELECT ${ROOM_COLS} FROM rooms r WHERE r.slug = $1`, [slug]);
  if (!rows[0]) throw new HttpError(404, 'no_room', NOT_FOUND);
  return rows[0];
}

/**
 * Who may see a room at all (list it, enter, read, post, be mentioned, report in it):
 *   site rooms   → every logged-in account
 *   member rooms → verified members only (trust ≥ 1, i.e. email confirmed);
 *                  if invite-only, only the owner, whitelisted members and admins
 */
export async function canView(v: Viewer, room: RoomRow): Promise<boolean> {
  if (room.kind === 'site') return true;
  if (v.trust >= Trust.Admin) return true;
  if (v.trust < Trust.Verified) return false;
  if (!room.whitelist_only || room.owner_id === v.id) return true;
  const { rowCount } = await db.query('SELECT 1 FROM room_whitelist WHERE room_id = $1 AND user_id = $2', [room.id, v.id]);
  return !!rowCount;
}

/** Throws unless the viewer may be in the room: visibility first, then bans and kicks. */
export async function assertRoomAccess(v: Viewer, room: RoomRow): Promise<void> {
  if (!(await canView(v, room))) {
    if (room.kind === 'member' && v.trust < Trust.Verified) {
      throw new HttpError(403, 'verify', 'Member rooms are for verified members. Confirm your email to get in.');
    }
    throw new HttpError(404, 'no_room', NOT_FOUND); // don't reveal that an invite-only room exists
  }
  const block = accessBlock(await activeSanctions(v.id, room.id));
  if (block) throw new HttpError(403, 'sanctioned', block);
}

export function isOwner(v: Viewer, room: RoomRow): boolean {
  return room.kind === 'member' && room.owner_id === v.id;
}

/** Owner or admin: may edit the room, its whitelist, and delete it. */
function assertCanManage(v: Viewer, room: RoomRow) {
  if (isOwner(v, room) || v.trust >= Trust.Admin) return;
  throw new HttpError(403, 'not_owner', 'Only the room owner can do that.');
}

export async function canModerateRoom(v: Viewer, room: RoomRow): Promise<boolean> {
  if (v.trust >= Trust.Admin || isOwner(v, room)) return true;
  if (v.trust < Trust.RoomModerator) return false;
  const { rowCount } = await db.query('SELECT 1 FROM room_moderators WHERE room_id = $1 AND user_id = $2', [room.id, v.id]);
  return !!rowCount;
}

/** After access rules tighten, push out anyone currently in the room who no longer qualifies. */
async function evictUnauthorized(io: IO, room: RoomRow, reason: string) {
  const sockets = await io.in(sockRooms.chat(room.id)).fetchSockets();
  const seen = new Set<string>();
  for (const s of sockets) {
    const userId = s.data.userId;
    if (seen.has(userId)) continue;
    seen.add(userId);
    const { rows } = await db.query<{ trust_level: number }>('SELECT trust_level FROM users WHERE id = $1', [userId]);
    if (!(await canView({ id: userId, trust: rows[0]?.trust_level ?? 0 }, room))) {
      await removeFromRoom(io, userId, room.id, reason, 0);
    }
  }
}

function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || 'room'}-${suffix}`;
}

const CreateBody = z.object({
  name: z.string().trim().min(MEMBER_ROOMS.nameMin).max(MEMBER_ROOMS.nameMax),
  description: z.string().trim().max(MEMBER_ROOMS.descriptionMax).optional(),
  whitelistOnly: z.boolean().default(false),
});
const PatchBody = z.object({
  name: z.string().trim().min(MEMBER_ROOMS.nameMin).max(MEMBER_ROOMS.nameMax).optional(),
  description: z.string().trim().max(MEMBER_ROOMS.descriptionMax).optional(),
  whitelistOnly: z.boolean().optional(),
  slowModeSeconds: z.number().int().min(0).max(600).optional(),
});

async function detail(v: Viewer, room: RoomRow): Promise<RoomDetail> {
  const manage = isOwner(v, room) || v.trust >= Trust.Admin;
  const [{ rows: owner }, whitelist] = await Promise.all([
    room.owner_id ? db.query<{ handle: string }>('SELECT handle FROM users WHERE id = $1', [room.owner_id]) : Promise.resolve({ rows: [] as { handle: string }[] }),
    manage
      ? db.query<{ handle: string }>(
          'SELECT u.handle FROM room_whitelist w JOIN users u ON u.id = w.user_id WHERE w.room_id = $1 ORDER BY lower(u.handle)',
          [room.id],
        ).then((r) => r.rows.map((x) => x.handle))
      : Promise.resolve(undefined),
  ]);
  return {
    id: room.id, slug: room.slug, name: room.name, kind: room.kind, description: room.description,
    whitelistOnly: room.whitelist_only, slowModeSeconds: room.slow_mode_seconds,
    ownerHandle: owner[0]?.handle ?? null, canManage: manage, canModerate: await canModerateRoom(v, room),
    ...(whitelist ? { whitelist } : {}),
  };
}

export function registerRoomRoutes(app: FastifyInstance, io: IO) {
  app.get<{ Params: { slug: string } }>('/api/rooms/:slug', async (req) => {
    const u = requireUser(req);
    const room = await roomBySlug(req.params.slug);
    await assertRoomAccess(u, room);
    return detail(u, room);
  });

  app.post('/api/rooms', async (req, reply) => {
    const u = requireUser(req);
    if (u.trust < Trust.Verified) throw new HttpError(403, 'verify', 'Confirm your email to create member rooms.');
    const b = parse(CreateBody, req.body);
    const site = await activeSanctions(u.id, null);
    if (site.some((s) => s.room_id === null && (s.kind === 'ban' || s.kind === 'mute'))) {
      throw new HttpError(403, 'sanctioned', "You can't create rooms while muted or banned.");
    }
    if (textBlocked(`${b.name} ${b.description ?? ''}`)) throw new HttpError(400, 'blocked_word', "The name or description contains a word that isn't allowed.");
    const { rows: owned } = await db.query<{ n: string }>("SELECT count(*) AS n FROM rooms WHERE kind = 'member' AND owner_id = $1", [u.id]);
    if (Number(owned[0].n) >= MEMBER_ROOMS.maxOwnedPerUser) {
      throw new HttpError(409, 'room_limit', `You can own up to ${MEMBER_ROOMS.maxOwnedPerUser} rooms. Delete one to make another.`);
    }
    const room = await tx(async (q) => {
      const { rows } = await q.query<RoomRow>(
        `INSERT INTO rooms (slug, name, category, sort_order, min_trust_to_post, kind, owner_id, whitelist_only, description)
         VALUES ($1, $2, 'Member rooms', 1000, $3, 'member', $4, $5, $6)
         RETURNING id, slug, name, category, kind, owner_id, whitelist_only, description, min_trust_to_post, slow_mode_seconds`,
        [slugify(b.name), b.name, Trust.Verified, u.id, b.whitelistOnly, b.description || null],
      );
      await audit(q, u.id, 'room_create', 'room', rows[0].id, { name: b.name, whitelistOnly: b.whitelistOnly });
      return rows[0];
    });
    return reply.status(201).send(await detail(u, room));
  });

  app.patch<{ Params: { slug: string } }>('/api/rooms/:slug', async (req) => {
    const u = requireUser(req, Trust.Verified);
    const room = await roomBySlug(req.params.slug);
    if (!(await canView(u, room))) throw new HttpError(404, 'no_room', NOT_FOUND);
    assertCanManage(u, room);
    const b = parse(PatchBody, req.body);
    if (textBlocked(`${b.name ?? ''} ${b.description ?? ''}`)) throw new HttpError(400, 'blocked_word', "The name or description contains a word that isn't allowed.");
    const { rows } = await db.query<RoomRow>(
      `UPDATE rooms r SET name = COALESCE($2, name), description = CASE WHEN $3::text IS NULL THEN description ELSE NULLIF($3, '') END,
              whitelist_only = COALESCE($4, whitelist_only), slow_mode_seconds = COALESCE($5, slow_mode_seconds)
        WHERE id = $1 RETURNING ${ROOM_COLS}`,
      [room.id, b.name ?? null, b.description ?? null, b.whitelistOnly ?? null, b.slowModeSeconds ?? null],
    );
    await audit(db, u.id, 'room_update', 'room', room.id, b);
    if (b.whitelistOnly && !room.whitelist_only) await evictUnauthorized(io, rows[0], 'This room is now invite-only.');
    if (b.slowModeSeconds !== undefined) {
      io.to(sockRooms.chat(room.id)).emit('notice', {
        message: b.slowModeSeconds ? `Slow mode is on: one message every ${b.slowModeSeconds} seconds.` : 'Slow mode is off.',
      });
    }
    return detail(u, rows[0]);
  });

  app.delete<{ Params: { slug: string } }>('/api/rooms/:slug', async (req) => {
    const u = requireUser(req, Trust.Verified);
    const room = await roomBySlug(req.params.slug);
    if (room.kind === 'site') throw new HttpError(400, 'site_room', 'Site rooms cannot be deleted.');
    if (!(await canView(u, room))) throw new HttpError(404, 'no_room', NOT_FOUND);
    assertCanManage(u, room);
    io.to(sockRooms.chat(room.id)).emit('kicked', { roomId: room.id, reason: 'This room was closed by its owner.', minutes: 0 });
    io.in(sockRooms.chat(room.id)).socketsLeave(sockRooms.chat(room.id));
    await tx(async (q) => {
      await q.query('DELETE FROM rooms WHERE id = $1', [room.id]); // messages and whitelist cascade; reports keep snapshots
      await audit(q, u.id, 'room_delete', 'room', room.id, { name: room.name, slug: room.slug });
    });
    return { ok: true };
  });

  app.put<{ Params: { slug: string; handle: string } }>('/api/rooms/:slug/whitelist/:handle', async (req) => {
    const u = requireUser(req, Trust.Verified);
    const room = await roomBySlug(req.params.slug);
    if (room.kind !== 'member' || !(await canView(u, room))) throw new HttpError(404, 'no_room', NOT_FOUND);
    assertCanManage(u, room);
    const { rows } = await db.query<{ id: string; trust_level: number }>('SELECT id, trust_level FROM users WHERE lower(handle) = lower($1)', [req.params.handle]);
    const t = rows[0];
    if (!t) throw new HttpError(404, 'no_user', 'No one has that handle.');
    if (t.trust_level < Trust.Verified) throw new HttpError(400, 'unverified', 'Only verified members can be added.');
    const { rows: c } = await db.query<{ n: string }>('SELECT count(*) AS n FROM room_whitelist WHERE room_id = $1', [room.id]);
    if (Number(c[0].n) >= MEMBER_ROOMS.maxWhitelist) throw new HttpError(409, 'whitelist_full', `A room's list holds up to ${MEMBER_ROOMS.maxWhitelist} members.`);
    await db.query('INSERT INTO room_whitelist (room_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [room.id, t.id, u.id]);
    await audit(db, u.id, 'whitelist_add', 'room', room.id, { userId: t.id });
    return { ok: true };
  });

  app.delete<{ Params: { slug: string; handle: string } }>('/api/rooms/:slug/whitelist/:handle', async (req) => {
    const u = requireUser(req, Trust.Verified);
    const room = await roomBySlug(req.params.slug);
    if (room.kind !== 'member' || !(await canView(u, room))) throw new HttpError(404, 'no_room', NOT_FOUND);
    assertCanManage(u, room);
    const { rows } = await db.query<{ user_id: string }>(
      `DELETE FROM room_whitelist w USING users x WHERE w.room_id = $1 AND w.user_id = x.id AND lower(x.handle) = lower($2) RETURNING w.user_id`,
      [room.id, req.params.handle],
    );
    if (rows[0]) {
      await audit(db, u.id, 'whitelist_remove', 'room', room.id, { userId: rows[0].user_id });
      if (room.whitelist_only) await removeFromRoom(io, rows[0].user_id, room.id, 'You were taken off this room’s invite list.', 0);
    }
    return { ok: true };
  });
}
