import type { FastifyInstance } from 'fastify';
import { Trust } from '../shared/config.js';
import type { OnlineUserDTO, OnlineUsersDTO, RoomPeopleDTO } from '../shared/types.js';
import { characterAgeText, prefsOf, showsQuill, USER_COLS, type UserRow } from './friends.js';
import { HttpError, requireUser } from './http.js';
import { assertRoomAccess, roomBySlug, roomRoles } from './rooms.js';
import { maskMature } from './safety/mature.js';
import { db, redis } from './store.js';

/**
 * Who is in a chat room right now: picture, name, and their character's city and age.
 * Only character details are ever shown, never anyone's real age. Members who blocked you,
 * or whom you ignore or block, are left out; people whose profile is friends-only show
 * just their name to non-friends.
 */
export function registerPeopleRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string } }>('/api/rooms/:slug/people', async (req): Promise<RoomPeopleDTO> => {
    const u = requireUser(req);
    const room = await roomBySlug(req.params.slug);
    await assertRoomAccess(u, room);
    const ids = ((await redis.hkeys(`presence:${room.id}`)) as string[]).filter((id) => /^\d{1,19}$/.test(id));
    if (!ids.length) return { people: [], hidden: 0, readOnly: room.read_only };
    const { rows: vr } = await db.query<{ user_id: string }>('SELECT user_id::text AS user_id FROM room_voices WHERE room_id = $1', [room.id]);
    const voiced = new Set(vr.map((r) => r.user_id));
    const roles = await roomRoles(room);
    const { rows } = await db.query<UserRow & { is_friend: boolean; hide: boolean }>(
      `SELECT ${USER_COLS},
              EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted'
                        AND f.user_a = LEAST($1::bigint, u.id) AND f.user_b = GREATEST($1::bigint, u.id)) AS is_friend,
              EXISTS (SELECT 1 FROM ignores i WHERE (i.user_id = $1 AND i.ignored_user_id = u.id)
                                               OR (i.user_id = u.id AND i.ignored_user_id = $1 AND i.mode = 'block')) AS hide
         FROM users u WHERE u.id = ANY($2::bigint[])
        ORDER BY lower(u.handle)`,
      [u.id, ids],
    );
    const staff = u.trust >= Trust.RoomModerator;
    const show = (t: string | null) => (t == null ? null : u.prefs.chatFilter ? maskMature(t) : t);
    const people = rows.filter((r) => !r.hide).map((r) => {
      const self = r.id === u.id;
      const visible = self || staff || r.is_friend || prefsOf(r).profileVisibility === 'everyone';
      return {
        id: r.id,
        handle: r.handle,
        avatar: visible && r.avatar_id ? `/media/${r.avatar_id}/thumb` : null,
        ...(showsQuill(r) ? { quill: true } : {}),
        characterCity: visible ? show(r.character_city) : null,
        characterAge: visible ? show(characterAgeText(r)) : null,
        isFriend: r.is_friend,
        self,
        isOwner: r.id === room.owner_id,
        role: roles[r.id] ?? null,
        voice: !room.read_only || r.id === room.owner_id || !!roles[r.id] || voiced.has(r.id),
      };
    });
    // You first, then friends, then everyone else by name.
    people.sort((a, b) => Number(b.self) - Number(a.self) || Number(b.isFriend) - Number(a.isFriend));
    // The room team first (owner, moderators, operators), then you, then friends, then everyone else.
    const rank = (p: { role: string | null }) => (p.role === 'owner' ? 3 : p.role === 'moderator' ? 2 : p.role === 'operator' ? 1 : 0);
    people.sort((a, b) => rank(b) - rank(a));
    return { people, hidden: rows.length - people.length, readOnly: room.read_only };
  });
}

const ONLINE_PAGE = 20;

/**
 * Online Users: members who are online and haven't hidden their online status. Anyone who
 * blocked you, or whom you ignore or block, is left out.
 */
export function registerOnlineRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { sample?: string; q?: string; page?: string } }>('/api/online', async (req): Promise<OnlineUsersDTO> => {
    const u = requireUser(req);
    const ids = ((await redis.hkeys('online')) as string[]).filter((id) => /^\d{1,19}$/.test(id) && id !== u.id);
    if (!ids.length) return { users: [], total: 0, page: 1, pages: 1 };
    const q = (req.query.q ?? '').trim().slice(0, 16);
    const { rows } = await db.query<UserRow & { is_friend: boolean }>(
      `SELECT ${USER_COLS},
              EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted'
                        AND f.user_a = LEAST($1::bigint, u.id) AND f.user_b = GREATEST($1::bigint, u.id)) AS is_friend
         FROM users u
        WHERE u.id = ANY($2::bigint[])
          AND is_adult_user(u.id)
          AND COALESCE((u.prefs->>'showOnline')::boolean, true)
          AND ($3 = '' OR lower(u.handle) LIKE '%' || lower($3) || '%')
          AND NOT EXISTS (SELECT 1 FROM ignores i WHERE (i.user_id = $1 AND i.ignored_user_id = u.id)
                                                   OR (i.user_id = u.id AND i.ignored_user_id = $1 AND i.mode = 'block'))
          AND NOT EXISTS (SELECT 1 FROM sanctions s WHERE s.user_id = u.id AND s.room_id IS NULL AND s.kind = 'ban'
                            AND (s.expires_at IS NULL OR s.expires_at > now()) AND s.revoked_at IS NULL)
        ORDER BY lower(u.handle)`,
      [u.id, ids, q.replace(/[%_\\]/g, '')],
    );
    const staff = u.trust >= Trust.RoomModerator;
    const toDTO = (r: UserRow & { is_friend: boolean }): OnlineUserDTO => {
      const visible = staff || r.is_friend || prefsOf(r).profileVisibility === 'everyone';
      const line = [characterAgeText(r), r.character_gender, r.character_city].filter(Boolean).join(', ');
      return {
        id: r.id, handle: r.handle,
        avatar: visible && r.avatar_id ? `/media/${r.avatar_id}/thumb` : null,
        ...(showsQuill(r) ? { quill: true } : {}),
        rpStyle: visible ? r.rp_style : null,
        characterLine: visible && line ? (u.prefs.chatFilter ? maskMature(line) : line) : null,
        isFriend: r.is_friend,
      };
    };
    if (req.query.sample) {
      // Up to 5 at random for the Home page.
      const pick = [...rows];
      for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; }
      return { users: pick.slice(0, 5).map(toDTO), total: rows.length, page: 1, pages: 1 };
    }
    const pages = Math.max(1, Math.ceil(rows.length / ONLINE_PAGE));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1));
    return { users: rows.slice((page - 1) * ONLINE_PAGE, page * ONLINE_PAGE).map(toDTO), total: rows.length, page, pages };
  });
}

const MEMBERS_PAGE = 20;

/**
 * Member search on the People page: online or offline members A to Z, by name, with or
 * without a (visible) profile picture. Someone who hides their online status is listed as
 * offline. Anyone who blocked you, or whom you ignore or block, and banned accounts are left out.
 * Friends-only profiles show just a name to non-friends and never count as having a picture.
 */
export function registerMemberSearch(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string; pic?: string; q?: string; page?: string } }>('/api/members', async (req): Promise<OnlineUsersDTO> => {
    const u = requireUser(req);
    const status = req.query.status === 'offline' ? 'offline' : 'online';
    const pic = req.query.pic === 'yes' || req.query.pic === 'no' ? req.query.pic : 'any';
    const q = (req.query.q ?? '').trim().slice(0, 16).replace(/[%_\\]/g, '');
    const onlineIds = ((await redis.hkeys('online')) as string[]).filter((id) => /^\d{1,19}$/.test(id));
    const page = Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1);
    const staff = u.trust >= Trust.RoomModerator;
    const { rows } = await db.query<UserRow & { is_friend: boolean; total: string }>(
      `WITH m AS (
         SELECT u.id,
                EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted'
                          AND f.user_a = LEAST($1::bigint, u.id) AND f.user_b = GREATEST($1::bigint, u.id)) AS is_friend,
                (u.id = ANY($2::bigint[]) AND COALESCE((u.prefs->>'showOnline')::boolean, true)) AS is_online
           FROM users u
          WHERE u.id <> $1
            AND is_adult_user(u.id)
            AND ($3 = '' OR lower(u.handle) LIKE '%' || lower($3) || '%')
            AND NOT EXISTS (SELECT 1 FROM ignores i WHERE (i.user_id = $1 AND i.ignored_user_id = u.id)
                                                     OR (i.user_id = u.id AND i.ignored_user_id = $1 AND i.mode = 'block'))
            AND NOT EXISTS (SELECT 1 FROM sanctions s WHERE s.user_id = u.id AND s.room_id IS NULL AND s.kind = 'ban'
                              AND (s.expires_at IS NULL OR s.expires_at > now()) AND s.revoked_at IS NULL)
       ), f AS (
         SELECT m.id, m.is_friend,
                (EXISTS (SELECT 1 FROM profile_photos p WHERE p.user_id = m.id AND NOT p.is_private AND p.review = 'approved')
                 AND ($4 OR m.is_friend OR COALESCE(u.prefs->>'profileVisibility', 'everyone') = 'everyone')) AS has_pic
           FROM m JOIN users u ON u.id = m.id
          WHERE m.is_online = ($5 = 'online')
       )
       SELECT ${USER_COLS}, f.is_friend, count(*) OVER () AS total
         FROM f JOIN users u ON u.id = f.id
        WHERE $6 = 'any' OR f.has_pic = ($6 = 'yes')
        ORDER BY lower(u.handle)
        LIMIT $7 OFFSET $8`,
      [u.id, onlineIds, q, staff, status, pic, MEMBERS_PAGE, (page - 1) * MEMBERS_PAGE],
    );
    const total = Number(rows[0]?.total ?? 0);
    const users = rows.map((r): OnlineUserDTO => {
      const visible = staff || r.is_friend || prefsOf(r).profileVisibility === 'everyone';
      const line = [characterAgeText(r), r.character_gender, r.character_city].filter(Boolean).join(', ');
      return {
        id: r.id, handle: r.handle,
        avatar: visible && r.avatar_id ? `/media/${r.avatar_id}/thumb` : null,
        ...(showsQuill(r) ? { quill: true } : {}),
        rpStyle: visible ? r.rp_style : null,
        characterLine: visible && line ? (u.prefs.chatFilter ? maskMature(line) : line) : null,
        isFriend: r.is_friend,
        online: status === 'online',
      };
    });
    // Past the last page (e.g. the list shrank): the caller asks again for page 1.
    return { users, total, page, pages: Math.max(1, Math.ceil(total / MEMBERS_PAGE)) };
  });
}
