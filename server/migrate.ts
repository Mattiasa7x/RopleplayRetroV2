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

  // ADMIN_HANDLE: the site owner's name. That account, and only that one, is the admin.
  const handle = process.env.ADMIN_HANDLE?.trim();
  const { rows: owner } = handle
    ? await db.query<{ id: string }>('SELECT id FROM users WHERE lower(handle) = lower($1)', [handle])
    : { rows: [] as { id: string }[] };
  if (owner[0]) {
    await db.query(
      `INSERT INTO app_secrets (key, value) VALUES ('admin_user_id', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [owner[0].id],
    );
    const { rows } = await db.query<{ id: string }>(
      `UPDATE users SET trust_level = $2, email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = $1 AND trust_level < $2 RETURNING id`,
      [owner[0].id, Trust.Admin],
    );
    if (rows[0]) {
      await audit(db, null, 'make_admin_env', 'user', rows[0].id);
      log(`${handle} is now the admin`);
    }
  } else {
    await db.query("DELETE FROM app_secrets WHERE key = 'admin_user_id'");
  }
  // Anyone else holding admin (from before this rule) steps down to site moderator.
  const { rows: demoted } = await db.query<{ id: string; handle: string }>(
    `UPDATE users SET trust_level = $1 WHERE trust_level >= $2
        AND id::text IS DISTINCT FROM (SELECT value FROM app_secrets WHERE key = 'admin_user_id')
      RETURNING id, handle`,
    [Trust.RoomModerator, Trust.Admin],
  );
  for (const d of demoted) {
    await audit(db, null, 'admin_removed', 'user', d.id);
    log(`${d.handle} is no longer an admin (only the site owner can be)`);
  }
}
