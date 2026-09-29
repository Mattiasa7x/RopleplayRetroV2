import type { FastifyInstance } from 'fastify';
import { characterAgeFrom, HANDLE_PATTERN, Trust, type Prefs } from '../shared/config.js';
import type { FriendState, FriendsDTO, PublicUser } from '../shared/types.js';
import { effectivePrefs, isMinor } from './account.js';
import { HttpError, requireUser } from './http.js';
import { isOnline, rooms, type IO } from './realtime.js';
import { pushTo } from './push.js';
import { slidingWindow } from './safety/limits.js';
import { audit, db, redis, type Tx } from './store.js';
import { afterFriendsChange } from './trophies.js';

export interface UserRow {
  id: string;
  handle: string;
  trust_level: number;
  created_at: Date;
  bio: string | null;
  prefs: Partial<Prefs>;
  birthdate: string | null;
  avatar_id: string | null;
  character_age: string | null;
  character_city: string | null;
  /** YYYY-MM-DD */
  character_birthday: string | null;
  character_gender: string | null;
  rp_style: string | null;
  character_sheet: Record<string, string> | null;
  profile_theme_id: number | null;
}

/** The character's age to show: from their character birthday, else what they typed before birthdays existed. */
export function characterAgeText(u: Pick<UserRow, 'character_birthday' | 'character_age'>): string | null {
  if (u.character_birthday) return String(characterAgeFrom(u.character_birthday));
  return u.character_age;
}

export const USER_COLS = `u.id, u.handle, u.trust_level, u.created_at, u.bio, u.prefs, u.birthdate, u.character_age, u.character_city,
  to_char(u.character_birthday, 'YYYY-MM-DD') AS character_birthday, u.character_gender, u.rp_style, u.character_sheet, u.profile_theme_id,
  (SELECT p.id FROM profile_photos p WHERE p.user_id = u.id AND NOT p.is_private ORDER BY p.position, p.id LIMIT 1) AS avatar_id`;

export function prefsOf(u: UserRow): Prefs {
  return effectivePrefs(u.prefs, isMinor(u.birthdate));
}

export async function userByHandle(handle: string): Promise<UserRow> {
  if (!HANDLE_PATTERN.test(handle)) throw new HttpError(404, 'no_user', 'No one has that name.');
  const { rows } = await db.query<UserRow>(`SELECT ${USER_COLS} FROM users u WHERE lower(u.handle) = lower($1)`, [handle]);
  if (!rows[0]) throw new HttpError(404, 'no_user', 'No one has that name.');
  return rows[0];
}

export function publicUser(u: UserRow, opts: { showAvatar?: boolean; online?: boolean } = {}): PublicUser {
  return {
    id: u.id,
    handle: u.handle,
    avatar: opts.showAvatar !== false && u.avatar_id ? `/media/${u.avatar_id}/thumb` : null,
    ...(opts.online !== undefined ? { online: opts.online } : {}),
  };
}

export interface Relation {
  iBlocked: boolean;
  theyBlocked: boolean;
  iIgnore: boolean;
  friendState: FriendState;
}

/** How two members relate: blocks, ignores and friendship, from `me`'s side. */
export async function relation(me: string, other: string): Promise<Relation> {
  if (me === other) return { iBlocked: false, theyBlocked: false, iIgnore: false, friendState: 'self' };
  const [{ rows: ig }, { rows: fr }] = await Promise.all([
    db.query<{ user_id: string; mode: string }>(
      'SELECT user_id, mode FROM ignores WHERE (user_id = $1 AND ignored_user_id = $2) OR (user_id = $2 AND ignored_user_id = $1)',
      [me, other],
    ),
    db.query<{ status: string; requested_by: string }>(
      'SELECT status, requested_by FROM friendships WHERE user_a = LEAST($1::bigint, $2::bigint) AND user_b = GREATEST($1::bigint, $2::bigint)',
      [me, other],
    ),
  ]);
  const mine = ig.find((r) => r.user_id === me);
  const theirs = ig.find((r) => r.user_id === other);
  const f = fr[0];
  const friendState: FriendState = !f ? 'none' : f.status === 'accepted' ? 'friends' : f.requested_by === me ? 'request_sent' : 'request_received';
  return { iBlocked: mine?.mode === 'block', theyBlocked: theirs?.mode === 'block', iIgnore: !!mine, friendState };
}

/** Accepted friend ids of a user. */
export async function friendIds(userId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS id
       FROM friendships WHERE (user_a = $1 OR user_b = $1) AND status = 'accepted'`,
    [userId],
  );
  return rows.map((r) => r.id);
}

/** Blocking someone ends any friendship or pending request between you. */
export async function endFriendship(q: Tx | typeof db, a: string, b: string) {
  await q.query('DELETE FROM friendships WHERE user_a = LEAST($1::bigint, $2::bigint) AND user_b = GREATEST($1::bigint, $2::bigint)', [a, b]);
  // Album access is for friends only, so it ends with the friendship.
  await q.query('DELETE FROM album_access WHERE (owner_id = $1 AND viewer_id = $2) OR (owner_id = $2 AND viewer_id = $1)', [a, b]);
}

export function registerFriendRoutes(app: FastifyInstance, io: IO) {
  app.get('/api/friends', async (req): Promise<FriendsDTO> => {
    const u = requireUser(req);
    const { rows } = await db.query<UserRow & { status: string; requested_by: string }>(
      `SELECT ${USER_COLS}, f.status, f.requested_by
         FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
        WHERE (f.user_a = $1 OR f.user_b = $1)
        ORDER BY lower(u.handle)`,
      [u.id],
    );
    const accepted = rows.filter((r) => r.status === 'accepted');
    const online = await isOnline(accepted.filter((r) => prefsOf(r).showOnline).map((r) => r.id));
    return {
      friends: accepted.map((r) => publicUser(r, { online: online.has(r.id) })).sort((a, b) => Number(b.online) - Number(a.online)),
      incoming: rows.filter((r) => r.status === 'pending' && r.requested_by !== u.id).map((r) => publicUser(r)),
      outgoing: rows.filter((r) => r.status === 'pending' && r.requested_by === u.id).map((r) => publicUser(r)),
    };
  });

  // Send a request, or accept one they already sent you.
  app.post<{ Params: { handle: string } }>('/api/friends/:handle', async (req) => {
    const u = requireUser(req);
    if (u.trust < Trust.Verified) throw new HttpError(403, 'verify', 'Confirm your email to add friends.');
    const t = await userByHandle(req.params.handle);
    if (t.id === u.id) throw new HttpError(400, 'self', "That's you!");
    const rel = await relation(u.id, t.id);
    if (rel.theyBlocked) throw new HttpError(404, 'no_user', 'No one has that name.');
    if (rel.iBlocked) throw new HttpError(400, 'blocked', 'Unblock them first.');
    if (rel.friendState === 'friends') return { ok: true, state: 'friends' };
    if (rel.friendState === 'request_sent') return { ok: true, state: 'request_sent' };
    if (rel.friendState === 'request_received') {
      await db.query(
        `UPDATE friendships SET status = 'accepted', accepted_at = now()
          WHERE user_a = LEAST($1::bigint, $2::bigint) AND user_b = GREATEST($1::bigint, $2::bigint)`,
        [u.id, t.id],
      );
      afterFriendsChange([u.id, t.id]);
      io.to(rooms.user(t.id)).emit('social', { kind: 'friend_accept', from: u.handle });
      pushTo(t.id, 'friend', { title: `${u.handle} accepted your friend request`, url: `/profile/${u.handle}`, tag: `friend-${u.handle}` });
      return { ok: true, state: 'friends' };
    }
    if (prefsOf(t).whoCanFriend === 'nobody') throw new HttpError(403, 'closed', `${t.handle} isn't accepting friend requests.`);
    if (!(await slidingWindow(redis, `rl:friend:${u.id}`, 20, 24 * 3600_000))) {
      throw new HttpError(429, 'rate', 'You can send 20 friend requests a day.');
    }
    await db.query(
      `INSERT INTO friendships (user_a, user_b, status, requested_by)
       VALUES (LEAST($1::bigint, $2::bigint), GREATEST($1::bigint, $2::bigint), 'pending', $1) ON CONFLICT DO NOTHING`,
      [u.id, t.id],
    );
    io.to(rooms.user(t.id)).emit('social', { kind: 'friend_request', from: u.handle });
    pushTo(t.id, 'friend', { title: `${u.handle} sent you a friend request`, url: '/friends', tag: `friend-${u.handle}` });
    return { ok: true, state: 'request_sent' };
  });

  // Unfriend, cancel your request, or decline theirs.
  app.delete<{ Params: { handle: string } }>('/api/friends/:handle', async (req) => {
    const u = requireUser(req);
    const t = await userByHandle(req.params.handle);
    await endFriendship(db, u.id, t.id);
    await audit(db, u.id, 'friend_remove', 'user', t.id);
    return { ok: true, state: 'none' };
  });
}
