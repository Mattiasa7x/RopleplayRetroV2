import pg from 'pg';
import { Redis } from 'ioredis';
import { env } from './env.js';

// Return BIGINT columns as strings (ids can exceed JS number precision).
pg.types.setTypeParser(20, (v: string) => v);

export const db = new pg.Pool({ connectionString: env.databaseUrl, max: 20 });
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
