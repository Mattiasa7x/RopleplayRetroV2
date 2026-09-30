import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MEMBER_ROOMS, Trust } from '../shared/config.js';
import { quillActive } from '../shared/quill.js';
import type { RoomDetail, RoomRole, RoomTeamMemberDTO } from '../shared/types.js';
import { HttpError, parse, requireUser } from './http.js';
import { removeFromRoom, rooms as sockRooms, type IO } from './realtime.js';
import { accessBlock, activeSanctions, textBlocked } from './safety/pipeline.js';
import { roomImageUrl, isPoolImage } from './room-images.js';
import { audit, db, redis, tx } from './store.js';

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
  image_id: number | null;
  /** Owner's chat filter: messages with swear words are refused in this room. */
  chat_filter: boolean;
  /** The room's picture has been downloaded and can be shown. */
  has_image: boolean;
  /** Only the owner and members given a voice may post. */
  read_only: boolean;
  /** Regional rooms: the section they're listed under ("United States") and, optionally, a sub-section ("West"). */
  region: string | null;
  subregion: string | null;
}

export const ROOM_COLS =
  `r.id, r.slug, r.name, r.category, r.kind, r.owner_id, r.whitelist_only, r.description, r.min_trust_to_post, r.slow_mode_seconds, r.region, r.subregion,
   r.image_id, r.chat_filter, r.read_only, COALESCE((SELECT ri.thumb_data IS NOT NULL FROM room_images ri WHERE ri.id = r.image_id), false) AS has_image`;

export interface Viewer {
  id: string;
  trust: number;
}

const NOT_FOUND = 'That room does not exist or is invite-only.';

/** May this person post in the room right now? (Read-only rooms: owner, room team, site staff, or given a voice.) */
export async function canSpeakIn(v: Viewer, room: RoomRow): Promise<boolean> {
  if (!room.read_only || room.owner_id === v.id || v.trust >= Trust.RoomModerator) return true;
  const { rowCount } = await db.query(
    `SELECT 1 FROM room_voices WHERE room_id = $1 AND user_id = $2
     UNION ALL SELECT 1 FROM room_roles WHERE room_id = $1 AND user_id = $2`, [room.id, v.id]);
  return !!rowCount;
}

/** A member room's team by user id: the owner, moderators and operators. Site rooms have none. */
export async function roomRoles(room: RoomRow): Promise<Record<string, RoomRole>> {
  if (room.kind !== 'member') return {};
  const { rows } = await db.query<{ user_id: string; role: 'moderator' | 'operator' }>(
    'SELECT user_id::text AS user_id, role FROM room_roles WHERE room_id = $1', [room.id]);
  const out: Record<string, RoomRole> = {};
  for (const r of rows) out[r.user_id] = r.role;
  if (room.owner_id) out[String(room.owner_id)] = 'owner';
  return out;
}

/** One person's place on a member room's team, or null. */
export async function roomRoleOf(room: RoomRow, userId: string): Promise<RoomRole | null> {
  if (room.kind !== 'member') return null;
  if (String(room.owner_id) === String(userId)) return 'owner';
  const { rows } = await db.query<{ role: 'moderator' | 'operator' }>('SELECT role FROM room_roles WHERE room_id = $1 AND user_id = $2', [room.id, userId]);
  return rows[0]?.role ?? null;
}

/** Tell everyone in the room who's on the team now (for the badges). */
export async function broadcastRoles(io: IO, room: RoomRow): Promise<void> {
  io.to(sockRooms.chat(room.id)).emit('room:roles', { roomId: room.id, roles: await roomRoles(room) });
}

/** Tell everyone in the room who may speak now. */
export async function broadcastVoices(io: IO, room: RoomRow): Promise<void> {
  const { rows } = await db.query<{ user_id: string }>('SELECT user_id::text AS user_id FROM room_voices WHERE room_id = $1', [room.id]);
  io.to(sockRooms.chat(room.id)).emit('room:voice', { roomId: room.id, readOnly: room.read_only, voices: rows.map((r) => r.user_id) });
}

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
  // Invite-only: people on the invite list, and the room's own team.
  const { rowCount } = await db.query(
    `SELECT 1 FROM room_whitelist WHERE room_id = $1 AND user_id = $2
     UNION ALL SELECT 1 FROM room_roles WHERE room_id = $1 AND user_id = $2`, [room.id, v.id]);
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
  // Site staff outrank every member room's owner; the room's own moderators and operators moderate it too.
  if (room.kind === 'member' && (v.trust >= Trust.RoomModerator || (await roomRoleOf(room, v.id)))) return true;
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
  imageId: z.number().int().positive().nullable().optional(),
  chatFilter: z.boolean().default(true),
});
const PatchBody = z.object({
  name: z.string().trim().min(MEMBER_ROOMS.nameMin).max(MEMBER_ROOMS.nameMax).optional(),
  chatFilter: z.boolean().optional(),
  description: z.string().trim().max(MEMBER_ROOMS.descriptionMax).optional(),
  whitelistOnly: z.boolean().optional(),
  slowModeSeconds: z.number().int().min(0).max(600).optional(),
  imageId: z.number().int().positive().nullable().optional(),
  readOnly: z.boolean().optional(),
});

async function detail(v: Viewer, room: RoomRow): Promise<RoomDetail> {
  const manage = isOwner(v, room) || v.trust >= Trust.Admin;
  const [{ rows: owner }, whitelist, { rows: img }, online, roles, team] = await Promise.all([
    room.owner_id ? db.query<{ handle: string }>('SELECT handle FROM users WHERE id = $1', [room.owner_id]) : Promise.resolve({ rows: [] as { handle: string }[] }),
    manage
      ? db.query<{ handle: string }>(
          'SELECT u.handle FROM room_whitelist w JOIN users u ON u.id = w.user_id WHERE w.room_id = $1 ORDER BY lower(u.handle)',
          [room.id],
        ).then((r) => r.rows.map((x) => x.handle))
      : Promise.resolve(undefined),
    room.image_id != null
      ? db.query<{ credit: string | null; credit_url: string | null }>('SELECT credit, credit_url FROM room_images WHERE id = $1', [room.image_id])
      : Promise.resolve({ rows: [] as { credit: string | null; credit_url: string | null }[] }),
    redis.hlen(`presence:${room.id}`),
    roomRoles(room),
    manage && room.kind === 'member'
      ? db.query<RoomTeamMemberDTO>(
          `SELECT u.handle, rr.role FROM room_roles rr JOIN users u ON u.id = rr.user_id
            WHERE rr.room_id = $1 ORDER BY rr.role, lower(u.handle)`, [room.id]).then((r) => r.rows)
      : Promise.resolve(undefined),
  ]);
  return {
    id: room.id, slug: room.slug, name: room.name, kind: room.kind, description: room.description,
    whitelistOnly: room.whitelist_only, slowModeSeconds: room.slow_mode_seconds,
    ownerHandle: owner[0]?.handle ?? null, canManage: manage, canModerate: await canModerateRoom(v, room),
    ...(whitelist ? { whitelist } : {}),
    image: roomImageUrl(room.image_id, room.has_image, 'full'),
    imageId: room.image_id,
    imageCredit: room.has_image && img[0]?.credit ? { name: img[0].credit, url: img[0].credit_url ?? '' } : null,
    online,
    chatFilter: room.kind === 'site' || room.chat_filter, // always on in site rooms
    readOnly: room.read_only,
    canSpeak: await canSpeakIn(v, room),
    myRole: roles[v.id] ?? null,
    roles,
    ...(team ? { team } : {}),
  };
}

export async function roomDetail(v: Viewer, room: RoomRow): Promise<RoomDetail> {
  return detail(v, room);
}

/** A picture from the pool; Gold Quill pictures only for members with an active pass. */
async function assertPoolImage(id: number | null | undefined, quill = false) {
  if (id != null && !(await isPoolImage(id, quill))) {
    throw new HttpError(400, 'bad_image', quill ? 'Pick one of the pictures shown.' : 'That picture is for Gold Quill members. Pick another, or get a pass.');
  }
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
    await assertPoolImage(b.imageId, quillActive(u.quillUntil));
    const slug = await tx(async (q) => {
      const { rows } = await q.query<{ id: number; slug: string }>(
        `INSERT INTO rooms (slug, name, category, sort_order, min_trust_to_post, kind, owner_id, whitelist_only, description, image_id, chat_filter)
         VALUES ($1, $2, 'Member rooms', 1000, $3, 'member', $4, $5, $6, $7, $8)
         RETURNING id, slug`,
        [slugify(b.name), b.name, Trust.Verified, u.id, b.whitelistOnly, b.description || null, b.imageId ?? null, b.chatFilter],
      );
      await audit(q, u.id, 'room_create', 'room', rows[0].id, { name: b.name, whitelistOnly: b.whitelistOnly });
      return rows[0].slug;
    });
    return reply.status(201).send(await detail(u, await roomBySlug(slug)));
  });

  app.patch<{ Params: { slug: string } }>('/api/rooms/:slug', async (req) => {
    const u = requireUser(req, Trust.Verified);
    const room = await roomBySlug(req.params.slug);
    if (!(await canView(u, room))) throw new HttpError(404, 'no_room', NOT_FOUND);
    assertCanManage(u, room);
    const b = parse(PatchBody, req.body);
    if (textBlocked(`${b.name ?? ''} ${b.description ?? ''}`)) throw new HttpError(400, 'blocked_word', "The name or description contains a word that isn't allowed.");
    if (room.kind === 'site' && b.whitelistOnly) throw new HttpError(400, 'site_room', 'Site rooms are open to everyone.');
    // A member room keeps the name it was made with.
    if (room.kind === 'member' && b.name !== undefined && b.name !== room.name) {
      throw new HttpError(400, 'name_locked', "A room's name can't be changed after it's made.");
    }
    await assertPoolImage(b.imageId, quillActive(u.quillUntil));
    const { rows } = await db.query<RoomRow>(
      `UPDATE rooms r SET name = COALESCE($2, name), description = CASE WHEN $3::text IS NULL THEN description ELSE NULLIF($3, '') END,
              whitelist_only = COALESCE($4, whitelist_only), slow_mode_seconds = COALESCE($5, slow_mode_seconds),
              image_id = CASE WHEN $6 THEN $7::int ELSE image_id END,
              chat_filter = COALESCE($8, chat_filter), read_only = COALESCE($9, read_only)
        WHERE id = $1 RETURNING ${ROOM_COLS}`,
      [room.id, room.kind === 'member' ? null : b.name ?? null, b.description ?? null, b.whitelistOnly ?? null, b.slowModeSeconds ?? null, b.imageId !== undefined, b.imageId ?? null, room.kind === 'member' ? b.chatFilter ?? null : null,
        room.kind === 'member' ? b.readOnly ?? null : null],
    );
    await audit(db, u.id, 'room_update', 'room', room.id, b);
    if (b.whitelistOnly && !room.whitelist_only) await evictUnauthorized(io, rows[0], 'This room is now invite-only.');
    if (b.chatFilter !== undefined && room.kind === 'member' && b.chatFilter !== room.chat_filter) {
      io.to(sockRooms.chat(room.id)).emit('notice', {
        message: b.chatFilter ? 'The chat filter is on: messages with swear words are blocked in this room.' : 'The chat filter is off: swear words are allowed in this room.',
      });
    }
    if (b.readOnly !== undefined && room.kind === 'member' && b.readOnly !== room.read_only) {
      // A fresh start either way: nobody but the owner has a voice until given one.
      await db.query('DELETE FROM room_voices WHERE room_id = $1', [room.id]);
      io.to(sockRooms.chat(room.id)).emit('notice', {
        message: b.readOnly ? 'This room is now read-only: only people the owner picks can chat.' : 'Read-only is off: everyone can chat again.',
      });
      await broadcastVoices(io, rows[0]);
    }
    if (b.slowModeSeconds !== undefined) {
      io.to(sockRooms.chat(room.id)).emit('notice', {
        message: b.slowModeSeconds ? `Slow mode is on: one message every ${b.slowModeSeconds} seconds.` : 'Slow mode is off.',
      });
    }
    return detail(u, rows[0]);
  });

  /** Read-only rooms: the owner gives (PUT) or takes back (DELETE) someone's voice. */
  const voice = (give: boolean) => async (req: FastifyRequest) => {
    const params = req.params as { slug: string; handle: string };
    const u = requireUser(req, Trust.Verified);
    const room = await roomBySlug(params.slug);
    if (!(await canView(u, room))) throw new HttpError(404, 'no_room', NOT_FOUND);
    assertCanManage(u, room);
    if (room.kind !== 'member') throw new HttpError(400, 'site_room', 'Only member rooms can be read-only.');
    const { rows: t } = await db.query<{ id: string; handle: string }>('SELECT id::text AS id, handle FROM users WHERE lower(handle) = lower($1)', [params.handle]);
    if (!t[0]) throw new HttpError(404, 'no_user', 'No one has that name.');
    if (t[0].id === room.owner_id) return { ok: true };
    if (give) await db.query('INSERT INTO room_voices (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [room.id, t[0].id]);
    else await db.query('DELETE FROM room_voices WHERE room_id = $1 AND user_id = $2', [room.id, t[0].id]);
    if (room.read_only) {
      io.to(sockRooms.user(t[0].id)).emit('notice', { message: give ? `You can chat in ${room.name} now.` : `${room.name} is read-only for you again.` });
    }
    await broadcastVoices(io, room);
    return { ok: true };
  };
  app.put<{ Params: { slug: string; handle: string } }>('/api/rooms/:slug/voice/:handle', voice(true));

  /**
   * The room team: the owner (or a site admin) makes someone a moderator or operator (PUT), or
   * takes the role away (DELETE). Member rooms only.
   */
  const RoleBody = z.object({ role: z.enum(['moderator', 'operator']) });
  const teamChange = (give: boolean) => async (req: FastifyRequest) => {
    const params = req.params as { slug: string; handle: string };
    const u = requireUser(req, Trust.Verified);
    const room = await roomBySlug(params.slug);
    if (!(await canView(u, room))) throw new HttpError(404, 'no_room', NOT_FOUND);
    assertCanManage(u, room);
    if (room.kind !== 'member') throw new HttpError(400, 'site_room', 'Site rooms are run by RoleplayRetro staff.');
    const { rows: t } = await db.query<{ id: string; handle: string; trust_level: number }>(
      'SELECT id::text AS id, handle, trust_level FROM users WHERE lower(handle) = lower($1)', [params.handle]);
    if (!t[0]) throw new HttpError(404, 'no_user', 'No one has that name.');
    if (t[0].id === String(room.owner_id)) throw new HttpError(400, 'owner', 'You already own this room.');
    if (give) {
      const { role } = parse(RoleBody, req.body);
      if (t[0].trust_level < Trust.Verified) throw new HttpError(400, 'unverified', `${t[0].handle} needs to confirm their email first.`);
      const { rows: c } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM room_roles WHERE room_id = $1 AND role = $2 AND user_id <> $3', [room.id, role, t[0].id]);
      const max = role === 'moderator' ? MEMBER_ROOMS.maxModerators : MEMBER_ROOMS.maxOperators;
      if (Number(c[0].n) >= max) throw new HttpError(400, 'team_full', `A room can have up to ${max} ${role}s.`);
      await db.query(
        `INSERT INTO room_roles (room_id, user_id, role, assigned_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role, assigned_by = EXCLUDED.assigned_by, created_at = now()`,
        [room.id, t[0].id, role, u.id]);
      await audit(db, u.id, 'room_role_set', 'user', t[0].id, { room: room.slug, role });
      io.to(sockRooms.user(t[0].id)).emit('notice', { message: `You're now ${role === 'moderator' ? 'a Moderator' : 'an Operator'} of ${room.name}.` });
    } else {
      const { rowCount } = await db.query('DELETE FROM room_roles WHERE room_id = $1 AND user_id = $2', [room.id, t[0].id]);
      if (rowCount) await audit(db, u.id, 'room_role_removed', 'user', t[0].id, { room: room.slug });
    }
    await broadcastRoles(io, room);
    return { ok: true };
  };
  app.put<{ Params: { slug: string; handle: string } }>('/api/rooms/:slug/roles/:handle', teamChange(true));
  app.delete<{ Params: { slug: string; handle: string } }>('/api/rooms/:slug/roles/:handle', teamChange(false));
  app.delete<{ Params: { slug: string; handle: string } }>('/api/rooms/:slug/voice/:handle', voice(false));

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
