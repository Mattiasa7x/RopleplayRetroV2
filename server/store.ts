import pg from 'pg';
import { Redis } from 'ioredis';
import { env } from './env.js';

// Return BIGINT columns as strings (ids can exceed JS number precision).
pg.types.setTypeParser(20, (v: string) => v);

// Neon's copy-paste URL ends with channel_binding=require, which not every pg version reads;
// TLS (sslmode=require) still protects the connection without it.
export const withoutChannelBinding = (url: string) => url.replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
const databaseUrl = withoutChannelBinding(env.databaseUrl);

/** Where the database is and how long one round trip takes (no password): shown in the start-up log. */
export async function describeDatabase(): Promise<string> {
  let host = '?';
  try { host = new URL(databaseUrl).hostname; } catch { /* not a URL */ }
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await db.query('SELECT 1');
    times.push(performance.now() - t);
  }
  return `database ${host}: round trip ${Math.round(Math.min(...times))} ms`;
}

export const db = new pg.Pool({
  connectionString: databaseUrl,
  max: 20,
  // Keep connections for a minute between requests (opening one takes several round trips),
  // but let them go when the site is quiet so a serverless database (Neon) can sleep.
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 15_000,
});
export const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 3 });

export type Tx = pg.PoolClient;

/** Run fn in a transaction; rolls back on throw. */
export async function tx<T>(fn: (client: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(
  q: Pick<pg.Pool, 'query'> | Tx,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string | number,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await q.query(
    'INSERT INTO audit_log (actor_id, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, targetType, String(targetId), detail],
  );
}
