import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Sliding-window limiter on a Redis sorted set. Returns true when the action is allowed.
 * Every attempt is counted, including ones later rejected by other checks, so spam
 * that trips the filter still burns the spammer's budget.
 */
export async function slidingWindow(redis: Redis, key: string, max: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const results = await redis
    .multi()
    .zremrangebyscore(key, 0, now - windowMs)
    .zadd(key, now, `${now}-${randomUUID()}`)
    .zcard(key)
    .pexpire(key, windowMs)
    .exec();
  const count = Number(results?.[2]?.[1] ?? 0);
  return count <= max;
}

/** Room slow mode: one message per `seconds` per user. */
export async function slowMode(redis: Redis, roomId: number, userId: string, seconds: number): Promise<boolean> {
  if (seconds <= 0) return true;
  const ok = await redis.set(`slow:${roomId}:${userId}`, '1', 'EX', seconds, 'NX');
  return ok === 'OK';
}

/**
 * Flood check: remembers hashes of a user's recent messages for `windowMs`.
 * Returns false if this message (after normalisation) was already sent in the window.
 */
export async function notRepeated(redis: Redis, userId: string, key: string, windowMs: number): Promise<boolean> {
  if (!key) return true;
  const digest = createHash('sha1').update(key).digest('base64url');
  const set = `flood:${userId}`;
  const now = Date.now();
  const res = await redis
    .multi()
    .zremrangebyscore(set, 0, now - windowMs)
    .zscore(set, digest)
    .zadd(set, now, digest)
    .pexpire(set, windowMs)
    .exec();
  return res?.[1]?.[1] == null;
}

/** Fixed daily counters (e.g. signups per network). Check first, bump only on success. */
function dayKey(key: string): string {
  return `${key}:${new Date().toISOString().slice(0, 10)}`;
}

export async function underDailyCap(redis: Redis, key: string, max: number): Promise<boolean> {
  return Number((await redis.get(dayKey(key))) ?? 0) < max;
}

export async function bumpDaily(redis: Redis, key: string): Promise<void> {
  const k = dayKey(key);
  await redis.multi().incr(k).expire(k, 26 * 3600).exec();
}
