import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import type { RoomImageDTO } from '../shared/types.js';
import { HttpError, requireUser } from './http.js';
import { regionalRooms } from './regional.js';
import { db } from './store.js';

/**
 * Room pictures: realistic photos for the 20 site rooms, plus a pool members can pick for
 * their own rooms. The list lives in server/db/room-images.json (free-licence Unsplash photos,
 * photographer credited). The server downloads and resizes any it doesn't have yet, in the
 * background after start, and stores them in the database, since Render's free tier has no disk.
 * Until a picture arrives, rooms show their colour art instead.
 */

interface Entry {
  slug: string;
  title: string;
  /** Site room this is the picture for, if any. */
  room: string | null;
  url: string;
  credit: string;
  creditUrl: string;
  page: string;
  /** Offered to members for their own rooms (regional place photos aren't). */
  pool?: boolean;
  /** Gold Quill members only. */
  quill?: boolean;
}

const FULL_EDGE = 1600;
const THUMB_EDGE = 640;

export const roomImageUrl = (id: number | null, hasImage: boolean, variant: 'full' | 'thumb' = 'thumb') =>
  id != null && hasImage ? `/room-img/${id}/${variant}` : null;

function entries(): Entry[] {
  const themed = JSON.parse(readFileSync('server/db/room-images.json', 'utf8')) as Entry[];
  // Each regional room's own place photo.
  const regional: Entry[] = regionalRooms().filter((r) => r.photo).map((r) => ({
    slug: `place-${r.slug}`, title: r.photo!.title, room: r.slug, url: r.photo!.url,
    credit: r.photo!.credit, creditUrl: r.photo!.creditUrl, page: r.photo!.page, pool: false,
  }));
  const quill = (JSON.parse(readFileSync('server/db/quill-themes.json', 'utf8')) as Entry[]).map((e) => ({ ...e, pool: true, quill: true }));
  return [...themed, ...regional, ...quill];
}

/** Runs on start (fast): make sure every listed picture has a row, and give site rooms theirs. */
export async function syncRoomImages(): Promise<void> {
  for (const e of entries()) {
    await db.query(
      `INSERT INTO room_images (slug, title, source_url, credit, credit_url, in_pool, quill_only)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, credit = EXCLUDED.credit, credit_url = EXCLUDED.credit_url,
         in_pool = EXCLUDED.in_pool, quill_only = EXCLUDED.quill_only,
         full_data = CASE WHEN room_images.source_url IS DISTINCT FROM EXCLUDED.source_url THEN NULL ELSE room_images.full_data END,
         thumb_data = CASE WHEN room_images.source_url IS DISTINCT FROM EXCLUDED.source_url THEN NULL ELSE room_images.thumb_data END,
         source_url = EXCLUDED.source_url`,
      [e.slug, e.title, e.page, e.credit, e.creditUrl, e.pool !== false, e.quill === true],
    );
    if (e.room) {
      await db.query(
        `UPDATE rooms SET image_id = (SELECT id FROM room_images WHERE slug = $1)
          WHERE slug = $2 AND kind = 'site' AND image_id IS NULL`,
        [e.slug, e.room],
      );
    }
  }
}

async function fetchImage(url: string): Promise<Buffer> {
  // The image CDN resizes on its side, so we never pull a 40-megapixel original.
  const res = await fetch(`${url}?w=${FULL_EDGE}&q=80&fm=jpg&fit=max`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Background: download any pictures not stored yet, one at a time. Safe to run on every start. */
export async function downloadMissingRoomImages(log: (m: string) => void): Promise<void> {
  const byPage = new Map(entries().map((e) => [e.page, e]));
  const { rows } = await db.query<{ id: number; slug: string; source_url: string }>(
    'SELECT id, slug, source_url FROM room_images WHERE full_data IS NULL OR thumb_data IS NULL ORDER BY id',
  );
  let ok = 0;
  for (const r of rows) {
    const e = byPage.get(r.source_url);
    if (!e) continue;
    try {
      const raw = await fetchImage(e.url);
      const full = await sharp(raw, { failOn: 'none' }).rotate()
        .resize({ width: FULL_EDGE, height: FULL_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 }).toBuffer();
      const thumb = await sharp(full).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside' }).webp({ quality: 72 }).toBuffer();
      await db.query('UPDATE room_images SET full_data = $2, thumb_data = $3, updated_at = now() WHERE id = $1', [r.id, full, thumb]);
      ok++;
    } catch (err) {
      log(`room picture ${r.slug} not downloaded: ${(err as Error).message}`);
    }
  }
  if (rows.length) log(`room pictures: ${ok} of ${rows.length} downloaded`);
}

/**
 * Room pictures change only when the list changes, so each one is read from the database once
 * and kept in memory (about 80 small WebP files, a few MB). Saves a database round trip per picture.
 */
const picCache = new Map<string, { data: Buffer; v: string }>();

export function registerRoomImageRoutes(app: FastifyInstance) {
  /** Room pictures: members only, like the rest of the site. Stock photos, so browsers may cache them privately. */
  app.get<{ Params: { id: string; variant: string } }>('/room-img/:id/:variant', async (req, reply) => {
    requireUser(req);
    if (!/^\d{1,9}$/.test(req.params.id)) throw new HttpError(404, 'no_image', 'Picture not found.');
    const col = req.params.variant === 'full' ? 'full_data' : 'thumb_data';
    const key = `${req.params.id}:${col}`;
    let pic = picCache.get(key);
    if (!pic) {
      const { rows } = await db.query<{ data: Buffer | null; v: string }>(
        `SELECT ${col} AS data, extract(epoch FROM updated_at)::bigint::text AS v FROM room_images WHERE id = $1`,
        [req.params.id],
      );
      if (!rows[0]?.data) throw new HttpError(404, 'no_image', 'Picture not found.');
      pic = { data: rows[0].data, v: rows[0].v };
      if (picCache.size < 400) picCache.set(key, pic);
    }
    const etag = `"ri${req.params.id}-${col}-${pic.v}"`;
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'private, max-age=604800');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    reply.header('Content-Type', 'image/webp');
    return reply.send(pic.data);
  });

  /** The pool members choose from for their rooms. */
  app.get('/api/room-images', async (req): Promise<RoomImageDTO[]> => {
    requireUser(req);
    const { rows } = await db.query<{ id: number; title: string; credit: string | null; credit_url: string | null; quill_only: boolean }>(
      'SELECT id, title, credit, credit_url, quill_only FROM room_images WHERE in_pool AND thumb_data IS NOT NULL ORDER BY quill_only DESC, title',
    );
    return rows.map((r) => ({ id: r.id, title: r.title, thumb: `/room-img/${r.id}/thumb`, credit: r.credit, creditUrl: r.credit_url, quill: r.quill_only }));
  });
}

/** True if the id is a pool picture that's ready to use (Gold Quill pictures only with an active pass). */
export async function isPoolImage(id: number, quill = false): Promise<boolean> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM room_images WHERE id = $1 AND in_pool AND thumb_data IS NOT NULL AND (NOT quill_only OR $2)', [id, quill]);
  return !!rowCount;
}
