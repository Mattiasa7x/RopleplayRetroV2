import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROFILE, Trust } from '../shared/config.js';
import type { HomeDTO, StatusDTO } from '../shared/types.js';
import { roomList } from './chat.js';
import { publicUser, USER_COLS, type UserRow } from './friends.js';
import { HttpError, parse, requireUser } from './http.js';
import { canView, roomBySlug } from './rooms.js';
import { maskMature } from './safety/mature.js';
import { checkSocialText } from './safety/social-text.js';
import { audit, db } from './store.js';

const TextBody = z.object({ body: z.string().max(20_000) });

export function registerFeedRoutes(app: FastifyInstance) {
  /** Home: favorite rooms + status updates from you and your friends, newest first. */
  app.get<{ Querystring: { before?: string } }>('/api/home', async (req): Promise<HomeDTO> => {
    const u = requireUser(req);
    const before = /^\d{1,19}$/.test(req.query.before ?? '') ? req.query.before : null;
    const [rooms, { rows }, { rows: pending }] = await Promise.all([
      before ? Promise.resolve([]) : roomList(u),
      db.query<UserRow & { sid: string; body: string; screated: Date }>(
        `SELECT s.id AS sid, s.body, s.created_at AS screated, ${USER_COLS}
           FROM statuses s JOIN users u ON u.id = s.user_id
          WHERE (s.user_id = $1 OR EXISTS (
                  SELECT 1 FROM friendships f WHERE f.status = 'accepted'
                     AND f.user_a = LEAST($1::bigint, s.user_id) AND f.user_b = GREATEST($1::bigint, s.user_id)))
            AND (s.hidden_at IS NULL OR s.user_id = $1)
            AND NOT EXISTS (SELECT 1 FROM ignores i WHERE i.user_id = $1 AND i.ignored_user_id = s.user_id)
            AND ($2::bigint IS NULL OR s.id < $2)
          ORDER BY s.id DESC LIMIT $3`,
        [u.id, before, PROFILE.feedPageSize],
      ),
      db.query<{ n: string }>(
        "SELECT count(*) AS n FROM friendships WHERE (user_a = $1 OR user_b = $1) AND status = 'pending' AND requested_by <> $1",
        [u.id],
      ),
    ]);
    const feed: StatusDTO[] = rows.map((r) => ({
      id: r.sid, author: publicUser(r), body: u.prefs.chatFilter ? maskMature(r.body) : r.body,
      createdAt: r.screated.toISOString(), canDelete: r.id === u.id || u.trust >= Trust.RoomModerator,
    }));
    return {
      favorites: rooms.filter((r) => r.favorite),
      feed,
      olderCursor: rows.length === PROFILE.feedPageSize ? rows[rows.length - 1].sid : null,
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
