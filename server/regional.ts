import { readFileSync } from 'node:fs';
import { db } from './store.js';

/**
 * Regional rooms: site rooms named after real places (states, provinces, countries), listed on
 * the Rooms page under "Regional" in collapsible sections. The list lives in
 * server/db/regional-rooms.json; each room's photo (free Unsplash licence, photographer credited)
 * is downloaded by room-images.ts like the other room pictures.
 */

export const REGIONAL_CATEGORY = 'Regional';

export interface RegionalPhoto {
  title: string;
  url: string;
  credit: string;
  creditUrl: string;
  page: string;
}

export interface RegionalRoom {
  slug: string;
  name: string;
  region: string;
  subregion: string | null;
  description: string;
  photo?: RegionalPhoto | null;
}

export function regionalRooms(): RegionalRoom[] {
  return JSON.parse(readFileSync('server/db/regional-rooms.json', 'utf8')) as RegionalRoom[];
}

/** Runs on start: create any regional rooms that don't exist yet and keep their details current. */
export async function syncRegionalRooms(): Promise<void> {
  const list = regionalRooms();
  for (const [i, r] of list.entries()) {
    await db.query(
      `INSERT INTO rooms (slug, name, category, sort_order, min_trust_to_post, description, region, subregion)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order,
         description = EXCLUDED.description, region = EXCLUDED.region, subregion = EXCLUDED.subregion
       WHERE rooms.kind = 'site' AND rooms.category = $3`,
      [r.slug, r.name, REGIONAL_CATEGORY, 1000 + i, r.description, r.region, r.subregion],
    );
  }
}
