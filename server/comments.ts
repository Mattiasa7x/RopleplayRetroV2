import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROFILE, Trust } from '../shared/config.js';
import type { CommentPageDTO, PhotoPageDTO } from '../shared/types.js';
import { publicUser, USER_COLS, type UserRow } from './friends.js';
import { HttpError, parse, requireUser, type SessionUser } from './http.js';
import { canViewPhoto, photoDTO, photoRow } from './photos.js';
import { profileAccess } from './profiles.js';
import { rooms, type IO } from './realtime.js';
import { maskMature } from './safety/mature.js';
import { pushTo } from './push.js';
import { checkSocialText } from './safety/social-text.js';
import { audit, db, tx } from './store.js';

/**
 * Comments on profiles and on photos. Both read newest first, a page at a time, and each
 * profile or photo keeps only its newest 1000: posting the 1001st deletes the oldest.
 */

type Where = { table: 'profile_comments' | 'photo_comments'; parentCol: 'profile_user_id' | 'photo_id'; parentId: string };

const TextBody = z.object({ body: z.string().max(20_000) });
const view = (u: SessionUser, text: string) => (u.prefs.chatFilter ? maskMature(text) : text);

function pageParams(q: { page?: string; size?: string }) {
  const size = q.size === String(PROFILE.commentsOnProfile) ? PROFILE.commentsOnProfile : PROFILE.commentsPerPage;
  const page = Math.max(1, Math.min(1000, Number.parseInt(q.page ?? '1', 10) || 1));
  return { size, page };
}

/** What this viewer may see: not hidden (unless it's theirs), nothing from people they ignore or who blocked them. */
const VISIBLE = `(c.hidden_at IS NULL OR c.author_id = $2)
  AND NOT EXISTS (SELECT 1 FROM ignores i WHERE (i.user_id = $2 AND i.ignored_user_id = c.author_id)
                                           OR (i.user_id = c.author_id AND i.ignored_user_id = $2 AND i.mode = 'block'))`;

async function listComments(w: Where, u: SessionUser, q: { page?: string; size?: string }, ownerId: string): Promise<CommentPageDTO> {
  const { size, page } = pageParams(q);
  const { rows: cnt } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${w.table} c WHERE c.${w.parentCol} = $1 AND ${VISIBLE}`, [w.parentId, u.id]);
  const total = Number(cnt[0].n);
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(page, pages);
  const { rows } = await db.query<UserRow & { cid: string; body: string; ccreated: Date }>(
    `SELECT c.id AS cid, c.body, c.created_at AS ccreated, ${USER_COLS}
       FROM ${w.table} c JOIN users u ON u.id = c.author_id
      WHERE c.${w.parentCol} = $1 AND ${VISIBLE}
      ORDER BY c.id DESC LIMIT $3 OFFSET $4`,
    [w.parentId, u.id, size, (p - 1) * size],
  );
  const owner = ownerId === u.id;
  return {
    comments: rows.map((r) => ({
      id: r.cid, author: publicUser(r), body: view(u, r.body), createdAt: r.ccreated.toISOString(),
      canDelete: owner || r.id === u.id || u.trust >= Trust.RoomModerator,
    })),
    page: p, pages, total,
  };
}

/** Add a comment and drop anything beyond the newest 1000 on that profile or photo. */
async function addComment(w: Where, u: SessionUser, raw: string): Promise<{ id: string; shadow: boolean }> {
  const v = await checkSocialText(u, raw, 'comment');
  if (!v.ok) throw new HttpError(400, v.error, v.message);
  return tx(async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO ${w.table} (${w.parentCol}, author_id, body, hidden_at) VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END) RETURNING id`,
      [w.parentId, u.id, v.body, v.shadow],
    );
    await q.query(
      `DELETE FROM ${w.table} WHERE ${w.parentCol} = $1
          AND id <= (SELECT id FROM ${w.table} WHERE ${w.parentCol} = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`,
      [w.parentId, PROFILE.commentsKept],
    );
    return { id: rows[0].id, shadow: v.shadow };
  });
}

async function photoFor(u: SessionUser, id: string) {
  const p = await photoRow(id);
  if (!p || !(await canViewPhoto(u, p))) throw new HttpError(404, 'no_photo', 'Photo not found.');
  const { rows } = await db.query<UserRow>(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1`, [p.user_id]);
  const access = await profileAccess(u, rows[0].handle);
  return { photo: p, owner: rows[0], canComment: access.canComment };
}

export function registerCommentRoutes(app: FastifyInstance, io: IO) {
  // ----- profile comments -----
  app.get<{ Params: { handle: string }; Querystring: { page?: string; size?: string } }>('/api/profiles/:handle/comments', async (req): Promise<CommentPageDTO> => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    if (!a.visible) return { comments: [], page: 1, pages: 1, total: 0 };
    return listComments({ table: 'profile_comments', parentCol: 'profile_user_id', parentId: a.target.id }, u, req.query, a.target.id);
  });

  app.post<{ Params: { handle: string } }>('/api/profiles/:handle/comments', async (req, reply) => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    if (!a.canComment) throw new HttpError(403, 'no_comment', `${a.target.handle} isn't taking comments from you.`);
    const c = await addComment({ table: 'profile_comments', parentCol: 'profile_user_id', parentId: a.target.id }, u, parse(TextBody, req.body).body);
    if (!c.shadow && a.target.id !== u.id) {
      io.to(rooms.user(a.target.id)).emit('social', { kind: 'comment', from: u.handle });
      pushTo(a.target.id, 'comment', { title: `${u.handle} commented on your profile`, url: `/profile/${a.target.handle}`, tag: 'profile-comment' });
    }
    return reply.status(201).send({ id: c.id });
  });

  app.delete<{ Params: { id: string } }>('/api/comments/:id', async (req) => {
    const u = requireUser(req);
    const { rowCount } = await db.query(
      'DELETE FROM profile_comments WHERE id = $1 AND (author_id = $2 OR profile_user_id = $2 OR $3)',
      [req.params.id, u.id, u.trust >= Trust.RoomModerator],
    );
    if (!rowCount) throw new HttpError(404, 'no_comment', 'Comment not found.');
    if (u.trust >= Trust.RoomModerator) await audit(db, u.id, 'comment_delete', 'comment', req.params.id);
    return { ok: true };
  });

  // ----- a single photo and its comments (same access rules as the photo itself) -----
  app.get<{ Params: { id: string } }>('/api/photos/:id', async (req): Promise<PhotoPageDTO> => {
    const u = requireUser(req);
    const f = await photoFor(u, req.params.id);
    return { photo: photoDTO(f.photo), owner: publicUser(f.owner), canComment: f.canComment, mine: f.owner.id === u.id };
  });

  app.get<{ Params: { id: string }; Querystring: { page?: string; size?: string } }>('/api/photos/:id/comments', async (req): Promise<CommentPageDTO> => {
    const u = requireUser(req);
    const f = await photoFor(u, req.params.id);
    return listComments({ table: 'photo_comments', parentCol: 'photo_id', parentId: f.photo.id }, u, req.query, f.owner.id);
  });

  app.post<{ Params: { id: string } }>('/api/photos/:id/comments', async (req, reply) => {
    const u = requireUser(req);
    const f = await photoFor(u, req.params.id);
    if (!f.canComment) throw new HttpError(403, 'no_comment', `${f.owner.handle} isn't taking comments from you.`);
    const c = await addComment({ table: 'photo_comments', parentCol: 'photo_id', parentId: f.photo.id }, u, parse(TextBody, req.body).body);
    if (!c.shadow && f.owner.id !== u.id) {
      io.to(rooms.user(f.owner.id)).emit('social', { kind: 'comment', from: u.handle });
      pushTo(f.owner.id, 'comment', { title: `${u.handle} commented on your photo`, url: `/photo/${f.photo.id}`, tag: `photo-${f.photo.id}` });
    }
    return reply.status(201).send({ id: c.id });
  });

  app.delete<{ Params: { id: string } }>('/api/photo-comments/:id', async (req) => {
    const u = requireUser(req);
    const { rowCount } = await db.query(
      `DELETE FROM photo_comments c USING profile_photos p
        WHERE c.id = $1 AND p.id = c.photo_id AND (c.author_id = $2 OR p.user_id = $2 OR $3)`,
      [req.params.id, u.id, u.trust >= Trust.RoomModerator],
    );
    if (!rowCount) throw new HttpError(404, 'no_comment', 'Comment not found.');
    if (u.trust >= Trust.RoomModerator) await audit(db, u.id, 'comment_delete', 'photo_comment', req.params.id);
    return { ok: true };
  });
}
