import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROFILE, TRUST_LABEL, Trust } from '../shared/config.js';
import type { CommentDTO, ProfileDTO, StatusDTO } from '../shared/types.js';
import { publicUser, prefsOf, relation, userByHandle, USER_COLS, type UserRow } from './friends.js';
import { HttpError, parse, requireUser, type SessionUser } from './http.js';
import { canViewAlbum, photoDTO } from './photos.js';
import { rooms, type IO } from './realtime.js';
import { maskMature } from './safety/mature.js';
import { textBlocked } from './safety/pipeline.js';
import { checkSocialText } from './safety/social-text.js';
import { audit, db } from './store.js';

// ---------------- profile visibility ----------------

interface Access {
  target: UserRow;
  visible: boolean;
  canComment: boolean;
  friendState: ProfileDTO['friendState'];
  iBlocked: boolean;
  iIgnore: boolean;
}

/** Who may see what on a profile. Throws 404 if the owner has blocked the viewer. */
export async function profileAccess(viewer: SessionUser, handle: string): Promise<Access> {
  const target = await userByHandle(handle);
  const rel = await relation(viewer.id, target.id);
  if (rel.theyBlocked) throw new HttpError(404, 'no_user', 'No one has that name.');
  const staff = viewer.trust >= Trust.RoomModerator;
  const self = rel.friendState === 'self';
  const friends = rel.friendState === 'friends';
  const p = prefsOf(target);
  const visible = !rel.iBlocked && (self || staff || friends || p.profileVisibility === 'everyone');
  const canComment =
    visible && !rel.iBlocked && viewer.trust >= Trust.Verified &&
    (self || (p.whoCanComment === 'everyone') || (p.whoCanComment === 'friends' && friends));
  return { target, visible, canComment, friendState: rel.friendState, iBlocked: rel.iBlocked, iIgnore: rel.iIgnore };
}

const view = (viewer: SessionUser, text: string) => (viewer.prefs.chatFilter ? maskMature(text) : text);

// ---------------- routes ----------------

const BioBody = z.object({ bio: z.string().trim().max(PROFILE.bioMax) });
const TextBody = z.object({ body: z.string().max(20_000) });

export function registerProfileRoutes(app: FastifyInstance, io: IO) {
  app.get<{ Params: { handle: string } }>('/api/profiles/:handle', async (req): Promise<ProfileDTO> => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    const t = a.target;
    const [{ rows: photos }, { rows: fc }, albumOk] = await Promise.all([
      a.visible
        ? db.query<{ id: string; is_private: boolean }>('SELECT id, is_private FROM profile_photos WHERE user_id = $1 AND NOT is_private ORDER BY position, id', [t.id])
        : Promise.resolve({ rows: [] as { id: string; is_private: boolean }[] }),
      db.query<{ n: string }>("SELECT count(*) AS n FROM friendships WHERE (user_a = $1 OR user_b = $1) AND status = 'accepted'", [t.id]),
      a.visible ? canViewAlbum(u, t.id) : Promise.resolve(false),
    ]);
    const { rows: ac } = albumOk
      ? await db.query<{ n: string }>('SELECT count(*) AS n FROM profile_photos WHERE user_id = $1 AND is_private', [t.id])
      : { rows: [{ n: '0' }] };
    return {
      ...publicUser(t, { showAvatar: a.visible }),
      bio: a.visible && t.bio ? view(u, t.bio) : null,
      joined: t.created_at.toISOString(),
      trustLabel: TRUST_LABEL[t.trust_level as Trust],
      photos: photos.map(photoDTO),
      canViewAlbum: albumOk,
      albumCount: albumOk ? Number(ac[0].n) : 0,
      friendCount: Number(fc[0].n),
      friendState: a.friendState,
      canComment: a.canComment,
      visible: a.visible,
      blockedByMe: a.iBlocked,
    };
  });

  app.patch('/api/me/profile', async (req) => {
    const u = requireUser(req);
    const { bio } = parse(BioBody, req.body);
    if (bio && textBlocked(bio)) throw new HttpError(400, 'blocked_word', "Your bio contains a word that isn't allowed.");
    await db.query('UPDATE users SET bio = NULLIF($2, \'\') WHERE id = $1', [u.id, bio]);
    return { ok: true };
  });

  // ----- comments on a profile -----
  app.get<{ Params: { handle: string }; Querystring: { before?: string } }>('/api/profiles/:handle/comments', async (req): Promise<CommentDTO[]> => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    if (!a.visible) return [];
    const before = /^\d{1,19}$/.test(req.query.before ?? '') ? req.query.before : null;
    const { rows } = await db.query<UserRow & { cid: string; body: string; ccreated: Date }>(
      `SELECT c.id AS cid, c.body, c.created_at AS ccreated, ${USER_COLS}
         FROM profile_comments c JOIN users u ON u.id = c.author_id
        WHERE c.profile_user_id = $1 AND ($3::bigint IS NULL OR c.id < $3)
          AND (c.hidden_at IS NULL OR c.author_id = $2)
          AND NOT EXISTS (SELECT 1 FROM ignores i WHERE (i.user_id = $2 AND i.ignored_user_id = c.author_id)
                                                   OR (i.user_id = c.author_id AND i.ignored_user_id = $2 AND i.mode = 'block'))
        ORDER BY c.id DESC LIMIT 20`,
      [a.target.id, u.id, before],
    );
    const owner = a.target.id === u.id;
    return rows.map((r) => ({
      id: r.cid, author: publicUser(r), body: view(u, r.body), createdAt: r.ccreated.toISOString(),
      canDelete: owner || r.id === u.id || u.trust >= Trust.RoomModerator,
    }));
  });

  app.post<{ Params: { handle: string } }>('/api/profiles/:handle/comments', async (req, reply) => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    if (!a.canComment) throw new HttpError(403, 'no_comment', `${a.target.handle} isn't taking comments from you.`);
    const v = await checkSocialText(u, parse(TextBody, req.body).body, 'comment');
    if (!v.ok) throw new HttpError(400, v.error, v.message);
    const { rows } = await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO profile_comments (profile_user_id, author_id, body, hidden_at)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END) RETURNING id, created_at`,
      [a.target.id, u.id, v.body, v.shadow],
    );
    if (!v.shadow && a.target.id !== u.id) io.to(rooms.user(a.target.id)).emit('social', { kind: 'comment', from: u.handle });
    return reply.status(201).send({ id: rows[0].id });
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

  // ----- a member's own status updates, on their profile -----
  app.get<{ Params: { handle: string } }>('/api/profiles/:handle/statuses', async (req): Promise<StatusDTO[]> => {
    const u = requireUser(req);
    const a = await profileAccess(u, req.params.handle);
    if (!a.visible || a.iIgnore) return [];
    const { rows } = await db.query<{ id: string; body: string; created_at: Date }>(
      `SELECT id, body, created_at FROM statuses WHERE user_id = $1 AND (hidden_at IS NULL OR user_id = $2) ORDER BY id DESC LIMIT 10`,
      [a.target.id, u.id],
    );
    return rows.map((r) => ({
      id: r.id, author: publicUser(a.target), body: view(u, r.body), createdAt: r.created_at.toISOString(),
      canDelete: a.target.id === u.id || u.trust >= Trust.RoomModerator,
    }));
  });
}
