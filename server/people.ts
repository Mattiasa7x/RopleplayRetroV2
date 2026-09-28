import type { FastifyInstance } from 'fastify';
import { Trust } from '../shared/config.js';
import type { RoomPeopleDTO } from '../shared/types.js';
import { characterAgeText, prefsOf, USER_COLS, type UserRow } from './friends.js';
import { requireUser } from './http.js';
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
