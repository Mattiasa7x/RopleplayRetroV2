import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HANDLE_PATTERN } from '../shared/config.js';
import { HttpError, parse, requireUser } from './http.js';
import { applyIgnore, type IO } from './realtime.js';
import { endFriendship } from './friends.js';
import { db } from './store.js';

const IgnoreBody = z.object({ mode: z.enum(['ignore', 'block']).default('ignore') });

async function userIdByHandle(handle: string): Promise<string> {
  if (!HANDLE_PATTERN.test(handle)) throw new HttpError(404, 'no_user', 'No one has that handle.');
  const { rows } = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(handle) = lower($1)', [handle]);
  if (!rows[0]) throw new HttpError(404, 'no_user', 'No one has that handle.');
  return rows[0].id;
}

/**
 * Ignore = hide their messages everywhere. Block = ignore + no mentions from them
 * (and, once private messages exist, no PMs). Both are stored server-side, so they
 * follow you across devices and are enforced before anything is sent to you.
 */
export function registerSocialRoutes(app: FastifyInstance, io: IO) {
  app.get('/api/ignores', async (req) => {
    const u = requireUser(req);
    const { rows } = await db.query(
      `SELECT u.handle, i.mode, i.created_at FROM ignores i JOIN users u ON u.id = i.ignored_user_id
        WHERE i.user_id = $1 ORDER BY lower(u.handle)`,
      [u.id],
    );
    return rows;
  });

  app.put<{ Params: { handle: string } }>('/api/ignores/:handle', async (req) => {
    const u = requireUser(req);
    const { mode } = parse(IgnoreBody, req.body ?? {});
    const target = await userIdByHandle(req.params.handle);
    if (target === u.id) throw new HttpError(400, 'self', "You can't ignore yourself.");
    const { rows: staff } = await db.query('SELECT trust_level FROM users WHERE id = $1', [target]);
    if (staff[0]?.trust_level >= 3) throw new HttpError(400, 'staff', "Moderators can't be ignored, so you always see their notices.");
    await db.query(
      `INSERT INTO ignores (user_id, ignored_user_id, mode) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, ignored_user_id) DO UPDATE SET mode = EXCLUDED.mode`,
      [u.id, target, mode],
    );
    if (mode === 'block') await endFriendship(db, u.id, target); // blocking ends any friendship
    await applyIgnore(io, u.id, target, true);
    return { ok: true };
  });

  app.delete<{ Params: { handle: string } }>('/api/ignores/:handle', async (req) => {
    const u = requireUser(req);
    const target = await userIdByHandle(req.params.handle);
    await db.query('DELETE FROM ignores WHERE user_id = $1 AND ignored_user_id = $2', [u.id, target]);
    await applyIgnore(io, u.id, target, false);
    return { ok: true };
  });
}
