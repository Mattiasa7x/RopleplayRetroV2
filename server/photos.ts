import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { PROFILE, Trust } from '../shared/config.js';
import type { PhotoDTO, PublicUser } from '../shared/types.js';
import { endFriendship, prefsOf, publicUser, relation, userByHandle, USER_COLS, type UserRow } from './friends.js';
import { HttpError, parse, requireUser, type SessionUser } from './http.js';
import { slidingWindow } from './safety/limits.js';
import { audit, db, redis } from './store.js';

// Keep memory low on small servers: one image at a time, no libvips cache.
sharp.concurrency(1);
sharp.cache(false);

export const photoDTO = (p: { id: string; is_private: boolean }): PhotoDTO => ({
  id: p.id,
  url: `/media/${p.id}/full`,
  thumb: `/media/${p.id}/thumb`,
  private: p.is_private,
});

// ---------------- image processing ----------------

/** 64-bit difference hash: survives re-saving, resizing and light edits, so copied photos are recognised. */
export async function dHash(img: Buffer): Promise<bigint> {
  const px = await sharp(img).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let h = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) h = (h << 1n) | (px[y * 9 + x] < px[y * 9 + x + 1] ? 1n : 0n);
  }
  return h;
}

/**
 * Any resolution in; two versions out: a sharp display copy (up to 2560 px) and a thumbnail.
 * Re-encoding fixes rotation and strips all metadata, including GPS location.
 */
export async function processPhoto(input: Buffer): Promise<{ full: Buffer; thumb: Buffer; width: number; height: number }> {
  const base = () => sharp(input, { limitInputPixels: PROFILE.photoMaxInputPixels, failOn: 'none' }).rotate();
  const fullOut = await base()
    .resize({ width: PROFILE.photoMaxEdge, height: PROFILE.photoMaxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84 })
    .toBuffer({ resolveWithObject: true });
  const thumb = await sharp(fullOut.data)
    .resize({ width: PROFILE.photoThumbEdge, height: PROFILE.photoThumbEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();
  return { full: fullOut.data, thumb, width: fullOut.info.width, height: fullOut.info.height };
}

export function looksLikeImage(b: Buffer): boolean {
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  const gif = b.subarray(0, 4).toString('latin1') === 'GIF8';
  return jpeg || png || webp || gif;
}

// ---------------- who can see which photo ----------------

async function isFriend(a: string, b: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM friendships WHERE status = 'accepted' AND user_a = LEAST($1::bigint, $2::bigint) AND user_b = GREATEST($1::bigint, $2::bigint)`,
    [a, b],
  );
  return !!rowCount;
}

/** Owner, or a friend the owner granted album access to. */
export async function canViewAlbum(viewer: { id: string; trust: number }, ownerId: string): Promise<boolean> {
  if (viewer.id === ownerId) return true;
  const rel = await relation(viewer.id, ownerId);
  if (rel.iBlocked || rel.theyBlocked) return false;
  if (rel.friendState !== 'friends') return false;
  const { rowCount } = await db.query('SELECT 1 FROM album_access WHERE owner_id = $1 AND viewer_id = $2', [ownerId, viewer.id]);
  return !!rowCount;
}

/**
 * Public photos follow the owner's profile visibility. Private-album photos are seen only by
 * the owner, friends granted album access, and anyone the photo was shared with in a message.
 * Blocks hide everything both ways. Moderators can open any photo to review reports.
 */
export async function canViewPhoto(viewer: { id: string; trust: number }, photo: { id: string; user_id: string; is_private: boolean }): Promise<boolean> {
  if (viewer.id === photo.user_id) return true;
  if (viewer.trust >= Trust.RoomModerator) return true;
  const rel = await relation(viewer.id, photo.user_id);
  if (rel.iBlocked || rel.theyBlocked) return false;
  const { rowCount: shared } = await db.query('SELECT 1 FROM photo_shares WHERE photo_id = $1 AND recipient_id = $2', [photo.id, viewer.id]);
  if (shared) return true;
  if (photo.is_private) return canViewAlbum(viewer, photo.user_id);
  const { rows } = await db.query<UserRow>(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1`, [photo.user_id]);
  if (!rows[0]) return false;
  return prefsOf(rows[0]).profileVisibility === 'everyone' || rel.friendState === 'friends';
}

export async function photoRow(id: string) {
  if (!/^\d{1,19}$/.test(id)) return null;
  const { rows } = await db.query<{ id: string; user_id: string; is_private: boolean }>(
    'SELECT id, user_id, is_private FROM profile_photos WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Blocking wipes album access both ways and un-shares photos between the two people. */
export async function cleanUpAfterBlock(a: string, b: string) {
  await endFriendship(db, a, b);
  await db.query(
    `DELETE FROM photo_shares s USING profile_photos p
      WHERE s.photo_id = p.id AND ((p.user_id = $1 AND s.recipient_id = $2) OR (p.user_id = $2 AND s.recipient_id = $1))`,
    [a, b],
  );
}

// ---------------- routes ----------------

const VisibilityBody = z.object({ private: z.boolean() });

export function registerPhotoRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: PROFILE.photoMaxBytes },
    (_req: unknown, body: Buffer, done: (err: Error | null, body?: Buffer) => void) => done(null, body),
  );

  /** Serve a photo, after checking the viewer is allowed to see it. */
  app.get<{ Params: { id: string; variant: string } }>('/media/:id/:variant', async (req, reply) => {
    const u = requireUser(req);
    const variant = req.params.variant === 'thumb' ? 'thumb' : 'full';
    const p = await photoRow(req.params.id);
    if (!p || !(await canViewPhoto(u, p))) throw new HttpError(404, 'no_photo', 'Photo not found.');
    const { rows } = await db.query<{ mime: string; data: Buffer }>('SELECT mime, data FROM photo_blobs WHERE photo_id = $1 AND variant = $2', [p.id, variant]);
    if (!rows[0]) throw new HttpError(404, 'no_photo', 'Photo not found.');
    reply.header('Content-Type', rows[0].mime);
    reply.header('Cache-Control', 'private, max-age=86400'); // only the viewer's own browser may cache it
    reply.header('ETag', `"${p.id}-${variant}"`);
    return reply.send(rows[0].data);
  });

  /** Upload one photo. ?private=1 puts it in the private album. */
  app.post<{ Querystring: { private?: string } }>('/api/me/photos', async (req, reply) => {
    const u = requireUser(req, Trust.Verified);
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || raw.length === 0) throw new HttpError(400, 'empty', 'No photo received.');
    if (!looksLikeImage(raw)) {
      throw new HttpError(415, 'type', 'Upload a JPEG, PNG, WebP or GIF photo. On iPhone, pick the photo from your library and it converts automatically.');
    }
    if (!(await slidingWindow(redis, `rl:photo:${u.id}`, PROFILE.photoUploadsPerHour, 3600_000))) {
      throw new HttpError(429, 'rate', `You can upload ${PROFILE.photoUploadsPerHour} photos an hour. Try again a little later.`);
    }
    let img: Awaited<ReturnType<typeof processPhoto>>;
    try {
      img = await processPhoto(raw);
    } catch {
      throw new HttpError(400, 'bad_image', "That photo couldn't be read. Try saving it as a JPEG first.");
    }
    const hash = BigInt.asIntN(64, await dHash(img.full)).toString();
    const { rowCount: clone } = await db.query(
      'SELECT 1 FROM profile_photos WHERE user_id <> $1 AND bit_count((dhash # $2::bigint)::bit(64)) <= $3 LIMIT 1',
      [u.id, hash, PROFILE.photoCloneDistance],
    );
    if (clone) {
      await audit(db, u.id, 'photo_clone_refused', 'user', u.id);
      throw new HttpError(409, 'clone', "This photo matches another member's photo, so it can't be used. Please upload your own.");
    }
    const isPrivate = req.query.private === '1';
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO profile_photos (user_id, dhash, position, is_private, width, height)
         VALUES ($1, $2, COALESCE((SELECT max(position) + 1 FROM profile_photos WHERE user_id = $1), 0), $3, $4, $5) RETURNING id`,
        [u.id, hash, isPrivate, img.width, img.height],
      );
      const id = rows[0].id;
      await client.query("INSERT INTO photo_blobs (photo_id, variant, mime, data) VALUES ($1, 'full', 'image/webp', $2), ($1, 'thumb', 'image/webp', $3)", [id, img.full, img.thumb]);
      await client.query('COMMIT');
      return reply.status(201).send(photoDTO({ id, is_private: isPrivate }));
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.delete<{ Params: { id: string } }>('/api/me/photos/:id', async (req) => {
    const u = requireUser(req);
    await db.query('DELETE FROM profile_photos WHERE id = $1 AND user_id = $2', [req.params.id, u.id]); // blobs + shares cascade
    return { ok: true };
  });

  /** Make a public photo the profile picture. */
  app.post<{ Params: { id: string } }>('/api/me/photos/:id/primary', async (req) => {
    const u = requireUser(req);
    await db.query(
      `UPDATE profile_photos SET position = CASE WHEN id = $1 THEN -1 ELSE position END WHERE user_id = $2 AND NOT is_private`,
      [req.params.id, u.id],
    );
    await db.query(
      `UPDATE profile_photos p SET position = r.n FROM (SELECT id, row_number() OVER (ORDER BY position, id) - 1 AS n FROM profile_photos WHERE user_id = $1) r WHERE p.id = r.id`,
      [u.id],
    );
    return { ok: true };
  });

  /** Move a photo between public photos and the private album. */
  app.post<{ Params: { id: string } }>('/api/me/photos/:id/visibility', async (req) => {
    const u = requireUser(req);
    const b = parse(VisibilityBody, req.body);
    const { rowCount } = await db.query('UPDATE profile_photos SET is_private = $3 WHERE id = $1 AND user_id = $2', [req.params.id, u.id, b.private]);
    if (!rowCount) throw new HttpError(404, 'no_photo', 'Photo not found.');
    return { ok: true };
  });

  /** A member's private album, if the viewer may see it. */
  app.get<{ Params: { handle: string } }>('/api/profiles/:handle/album', async (req) => {
    const u = requireUser(req);
    const owner = await userByHandle(req.params.handle);
    if (!(await canViewAlbum(u, owner.id))) throw new HttpError(403, 'album', 'This album is private.');
    const { rows } = await db.query<{ id: string; is_private: boolean }>(
      'SELECT id, is_private FROM profile_photos WHERE user_id = $1 AND is_private ORDER BY position, id',
      [owner.id],
    );
    return rows.map(photoDTO);
  });

  /** All my photos (public and private), e.g. to pick one to share in a message. */
  app.get('/api/me/photos', async (req) => {
    const u = requireUser(req);
    const { rows } = await db.query<{ id: string; is_private: boolean }>(
      'SELECT id, is_private FROM profile_photos WHERE user_id = $1 ORDER BY is_private, position, id',
      [u.id],
    );
    return rows.map(photoDTO);
  });

  // ----- album access: friends I let see my private album -----
  app.get('/api/me/album-access', async (req): Promise<PublicUser[]> => {
    const u = requireUser(req);
    const { rows } = await db.query<UserRow>(
      `SELECT ${USER_COLS} FROM album_access a JOIN users u ON u.id = a.viewer_id WHERE a.owner_id = $1 ORDER BY lower(u.handle)`,
      [u.id],
    );
    return rows.map((r) => publicUser(r));
  });

  app.put<{ Params: { handle: string } }>('/api/me/album-access/:handle', async (req) => {
    const u = requireUser(req);
    const t = await userByHandle(req.params.handle);
    if (!(await isFriend(u.id, t.id))) throw new HttpError(400, 'not_friend', 'You can only give album access to friends.');
    await db.query('INSERT INTO album_access (owner_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, t.id]);
    return { ok: true };
  });

  app.delete<{ Params: { handle: string } }>('/api/me/album-access/:handle', async (req) => {
    const u = requireUser(req);
    const t = await userByHandle(req.params.handle);
    await db.query('DELETE FROM album_access WHERE owner_id = $1 AND viewer_id = $2', [u.id, t.id]);
    return { ok: true };
  });
}

export type { SessionUser };
