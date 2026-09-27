import { readFileSync } from 'node:fs';
import { Trust } from '../shared/config.js';
import { audit, db } from './store.js';

/**
 * Runs on every start. The schema and seed files are safe to re-run, so this creates
 * the tables on the first deploy and quietly adds anything new on later ones.
 * (Render's free tier has no shell, so there's nowhere to run `npm run db:init` by hand.)
 */
export async function migrate(log: (m: string) => void): Promise<void> {
  if (process.env.AUTO_MIGRATE === 'false') return;
  for (const file of ['server/db/schema.sql', 'server/db/seed.sql']) {
    await db.query(readFileSync(file, 'utf8'));
  }
  log('database schema is up to date');

  // ADMIN_HANDLE: the site owner's name. Once that account exists, it's made an admin on start.
  const handle = process.env.ADMIN_HANDLE?.trim();
  if (handle) {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE users SET trust_level = $2, email_verified_at = COALESCE(email_verified_at, now())
        WHERE lower(handle) = lower($1) AND trust_level < $2 RETURNING id`,
      [handle, Trust.Admin],
    );
    if (rows[0]) {
      await audit(db, null, 'make_admin_env', 'user', rows[0].id);
      log(`${handle} is now an admin`);
    }
  }
}
