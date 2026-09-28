import type { FastifyInstance } from 'fastify';
import { Trust } from '../shared/config.js';
import type { OnlineUserDTO, OnlineUsersDTO, RoomPeopleDTO } from '../shared/types.js';
import { characterAgeText, prefsOf, USER_COLS, type UserRow } from './friends.js';
import { HttpError, requireUser } from './http.js';
import { assertRoomAccess, roomBySlug } from './rooms.js';
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
    if (!ids.length) return { people: [], hidden: 0 };
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
        characterCity: visible ? show(r.character_city) : null,
        characterAge: visible ? show(characterAgeText(r)) : null,
        isFriend: r.is_friend,
        self,
      };
    });
    // You first, then friends, then everyone else by name.
    people.sort((a, b) => Number(b.self) - Number(a.self) || Number(b.isFriend) - Number(a.isFriend));
    return { people, hidden: rows.length - people.length };
  });
}

const ONLINE_PAGE = 20;

/**
 * Online Users: adults (18+) who are online and haven't hidden their online status.
 * Members under 18 are never listed, and can't browse the list either. Anyone who blocked
 * you, or whom you ignore or block, is left out.
 */
export function registerOnlineRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { sample?: string; q?: string; page?: string } }>('/api/online', async (req): Promise<OnlineUsersDTO> => {
    const u = requireUser(req);
    if (u.isMinor) throw new HttpError(403, 'adults_only', 'Online Users is for members 18 and over.');
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
