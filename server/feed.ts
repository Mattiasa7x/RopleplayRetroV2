import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROFILE, Trust } from '../shared/config.js';
import type { ActivityDTO, HomeDTO } from '../shared/types.js';
import { roomList } from './chat.js';
import { prefsOf, publicUser, USER_COLS, type UserRow } from './friends.js';
import { HttpError, parse, requireUser, type SessionUser } from './http.js';
import { photoDTO } from './photos.js';
import { canView, roomBySlug } from './rooms.js';
import { maskMature } from './safety/mature.js';
import { checkSocialText } from './safety/social-text.js';
import { audit, db } from './store.js';

const TextBody = z.object({ body: z.string().max(20_000) });

/** Feed cursor: a timestamp with microseconds, exactly as the server sent it. */
const CURSOR = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const AT = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const view = (u: SessionUser, text: string) => (u.prefs.chatFilter ? maskMature(text) : text);

async function meRow(id: string): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1`, [id]);
  return rows[0];
}

/**
 * Newest-first activity from the viewer's friends (minus anyone they ignore), merged from
 * four sources. Hidden (moderated or shadow-muted) posts, private photos and comments on
 * profiles the viewer isn't allowed to see never appear. The viewer's own actions never do.
 */
export async function friendActivity(u: SessionUser, before: string | null): Promise<{ items: ActivityDTO[]; olderCursor: string | null }> {
  const n = PROFILE.feedPageSize;
  const { rows: fr } = await db.query<{ id: string }>(
    `SELECT CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END AS id
       FROM friendships f
      WHERE (f.user_a = $1 OR f.user_b = $1) AND f.status = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM ignores i WHERE i.user_id = $1
                          AND i.ignored_user_id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END)`,
    [u.id],
  );
  const friends = fr.map((r) => r.id);
  if (!friends.length) return { items: [], olderCursor: null };
  const args = [friends, before, n];
  const [statuses, comments, photos, profiles] = await Promise.all([
    db.query<UserRow & { sid: string; body: string; at: string }>(
      `SELECT s.id AS sid, s.body, ${AT('s.created_at')} AS at, ${USER_COLS}
         FROM statuses s JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ANY($1::bigint[]) AND s.hidden_at IS NULL AND ($2::timestamptz IS NULL OR s.created_at < $2)
        ORDER BY s.created_at DESC LIMIT $3`, args),
    db.query<UserRow & { cid: string; body: string; at: string; target_id: string }>(
      `SELECT c.id AS cid, c.body, ${AT('c.created_at')} AS at, c.profile_user_id AS target_id, ${USER_COLS}
         FROM profile_comments c JOIN users u ON u.id = c.author_id
        WHERE c.author_id = ANY($1::bigint[]) AND c.hidden_at IS NULL AND ($2::timestamptz IS NULL OR c.created_at < $2)
        ORDER BY c.created_at DESC LIMIT $3`, args),
    db.query<UserRow & { at: string; ids: string[]; count: string }>(
      `SELECT g.at, g.ids, g.count, ${USER_COLS}
         FROM (SELECT p.user_id, ${AT('max(p.created_at)')} AS at, max(p.created_at) AS sort_at,
                      (array_agg(p.id ORDER BY p.id DESC))[1:4]::text[] AS ids, count(*) AS count
                 FROM profile_photos p
                WHERE p.user_id = ANY($1::bigint[]) AND NOT p.is_private AND ($2::timestamptz IS NULL OR p.created_at < $2)
                GROUP BY p.user_id, date_trunc('day', p.created_at)
                ORDER BY sort_at DESC LIMIT $3) g
         JOIN users u ON u.id = g.user_id
        ORDER BY g.sort_at DESC`, args),
    db.query<UserRow & { at: string }>(
      `SELECT ${AT('u.profile_updated_at')} AS at, ${USER_COLS}
         FROM users u
        WHERE u.id = ANY($1::bigint[]) AND u.profile_updated_at IS NOT NULL AND ($2::timestamptz IS NULL OR u.profile_updated_at < $2)
        ORDER BY u.profile_updated_at DESC LIMIT $3`, args),
  ]);

  // Comments on someone else's profile show only if you could open that profile yourself.
  const targetIds = [...new Set(comments.rows.map((c) => c.target_id).filter((id) => id !== u.id))];
  const targets = new Map<string, { row: UserRow; ok: boolean }>();
  if (targetIds.length) {
    const { rows } = await db.query<UserRow & { is_friend: boolean; hide: boolean }>(
      `SELECT ${USER_COLS},
              EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted'
                        AND f.user_a = LEAST($1::bigint, u.id) AND f.user_b = GREATEST($1::bigint, u.id)) AS is_friend,
              EXISTS (SELECT 1 FROM ignores i WHERE (i.user_id = $1 AND i.ignored_user_id = u.id)
                                               OR (i.user_id = u.id AND i.ignored_user_id = $1 AND i.mode = 'block')) AS hide
         FROM users u WHERE u.id = ANY($2::bigint[])`,
      [u.id, targetIds],
    );
    const staff = u.trust >= Trust.RoomModerator;
    for (const r of rows) targets.set(r.id, { row: r, ok: !r.hide && (staff || r.is_friend || prefsOf(r).profileVisibility === 'everyone') });
  }
  const self = publicUser(await meRow(u.id));

  const items: ActivityDTO[] = [
    ...statuses.rows.map((r): ActivityDTO => ({ kind: 'status', key: `s${r.sid}`, at: r.at, actor: publicUser(r), statusId: r.sid, body: view(u, r.body) })),
    ...comments.rows.flatMap((r): ActivityDTO[] => {
      const onMe = r.target_id === u.id;
      const t = onMe ? null : targets.get(r.target_id);
      if (!onMe && !t?.ok) return [];
      return [{ kind: 'comment', key: `c${r.cid}`, at: r.at, actor: publicUser(r), commentId: r.cid, body: view(u, r.body), target: onMe ? self : publicUser(t!.row), onMe }];
    }),
    ...photos.rows.map((r): ActivityDTO => ({
      kind: 'photos', key: `p${r.ids[0]}`, at: r.at, actor: publicUser(r),
      photos: r.ids.map((id) => photoDTO({ id, is_private: false })), count: Number(r.count),
    })),
    ...profiles.rows.map((r): ActivityDTO => ({ kind: 'profile', key: `u${r.id}-${r.at}`, at: r.at, actor: publicUser(r) })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const more = items.length > n || [statuses, comments, photos, profiles].some((q) => q.rows.length === n);
  const page = items.slice(0, n);
  return { items: page, olderCursor: more && page.length ? page[page.length - 1].at : null };
}

export function registerFeedRoutes(app: FastifyInstance) {
  /**
   * Home: your latest status, what your friends have been up to (statuses, comments,
   * new photos, profile edits; never your own), and the six busiest rooms.
   */
  app.get<{ Querystring: { before?: string } }>('/api/home', async (req): Promise<HomeDTO> => {
    const u = requireUser(req);
    const before = CURSOR.test(req.query.before ?? '') ? req.query.before! : null;
    const [rooms, { rows: mine }, { rows: pending }, activity] = await Promise.all([
      before ? Promise.resolve([]) : roomList(u),
      before
        ? Promise.resolve({ rows: [] as { id: string; body: string; created_at: Date }[] })
        : db.query<{ id: string; body: string; created_at: Date }>(
            'SELECT id, body, created_at FROM statuses WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [u.id]),
      db.query<{ n: string }>(
        "SELECT count(*) AS n FROM friendships WHERE (user_a = $1 OR user_b = $1) AND status = 'pending' AND requested_by <> $1",
        [u.id],
      ),
      friendActivity(u, before),
    ]);
    const self = publicUser(await meRow(u.id));
    return {
      myStatus: mine[0]
        ? { id: mine[0].id, author: self, body: view(u, mine[0].body), createdAt: mine[0].created_at.toISOString(), canDelete: true }
        : null,
      feed: activity.items,
      olderCursor: activity.olderCursor,
      topRooms: rooms
        .map((r, i) => ({ r, i }))
        .sort((a, b) => b.r.online - a.r.online || a.i - b.i)
        .slice(0, 6)
        .map((x) => x.r),
      pendingRequests: Number(pending[0].n),
    };
  });

  app.post('/api/statuses', async (req, reply) => {
    const u = requireUser(req);
    const v = await checkSocialText(u, parse(TextBody, req.body).body, 'status');
    if (!v.ok) throw new HttpError(400, v.error, v.message);
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO statuses (user_id, body, hidden_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END) RETURNING id',
      [u.id, v.body, v.shadow],
    );
    return reply.status(201).send({ id: rows[0].id });
  });

  app.delete<{ Params: { id: string } }>('/api/statuses/:id', async (req) => {
    const u = requireUser(req);
    const staff = u.trust >= Trust.RoomModerator;
    const { rowCount } = await db.query('DELETE FROM statuses WHERE id = $1 AND (user_id = $2 OR $3)', [req.params.id, u.id, staff]);
    if (!rowCount) throw new HttpError(404, 'no_status', 'Status not found.');
    if (staff) await audit(db, u.id, 'status_delete', 'status', req.params.id);
    return { ok: true };
  });

  // ----- favorite rooms -----
  app.put<{ Params: { slug: string } }>('/api/favorites/:slug', async (req) => {
    const u = requireUser(req);
    const room = await roomBySlug(req.params.slug);
    if (!(await canView(u, room))) throw new HttpError(404, 'no_room', 'That room does not exist or is invite-only.');
    await db.query('INSERT INTO room_favorites (user_id, room_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, room.id]);
    return { ok: true, favorite: true };
  });

  app.delete<{ Params: { slug: string } }>('/api/favorites/:slug', async (req) => {
    const u = requireUser(req);
    const room = await roomBySlug(req.params.slug);
    await db.query('DELETE FROM room_favorites WHERE user_id = $1 AND room_id = $2', [u.id, room.id]);
    return { ok: true, favorite: false };
  });
}
