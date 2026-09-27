import { SITE_ROOMS } from '../../shared/config.js';
import { audit, db, redis } from '../store.js';
import { strikeAction } from './strike-rules.js';

/**
 * Strict auto-moderation for the 20 site rooms.
 *
 * Every message a user tries to send in a site room that is rejected for rule-breaking
 * (not for harmless reasons like being too long) counts as a strike:
 *   3 strikes in 10 minutes  → automatic 15-minute mute in that room
 *   6 strikes in 1 hour      → automatic 60-minute site-wide mute + flagged for admin review
 * Room-hopping (too many room joins a minute) also counts as a strike.
 * All automatic actions are written to the audit log with actor = system.
 */
export const STRIKE_CODES = new Set(['blocked_word', 'link', 'repeat', 'caps', 'mentions', 'rate', 'room_hop']);
// Slow-mode waits are deliberately NOT strikes: new accounts would get muted just for typing quickly.


/** Record a strike; applies an automatic mute when thresholds are hit. Returns a sentence to show the user, if any. */
export async function recordStrike(userId: string, roomId: number | null, code: string): Promise<string | null> {
  const key = `strikes:${userId}`;
  const now = Date.now();
  const windowMs = SITE_ROOMS.strikeWindowMinutes * 60_000;
  const res = await redis
    .multi()
    .zremrangebyscore(key, 0, now - 3600_000)
    .zadd(key, now, `${now}:${roomId ?? 0}:${code}`)
    .zcount(key, now - windowMs, '+inf')
    .zcard(key)
    .expire(key, 3600)
    .exec();
  const inWindow = Number(res?.[2]?.[1] ?? 0);
  const inHour = Number(res?.[3]?.[1] ?? 0);
  const action = strikeAction(inWindow, inHour);
  if (action === 'none') return null;

  if (action === 'site_mute') {
    await db.query(
      `INSERT INTO sanctions (user_id, kind, room_id, reason, issued_by, expires_at)
       VALUES ($1, 'mute', NULL, $2, NULL, now() + make_interval(mins => $3))`,
      [userId, 'Automatic: repeated rule-breaking across site rooms', SITE_ROOMS.siteMuteMinutes],
    );
    await db.query('UPDATE users SET needs_review = true WHERE id = $1', [userId]);
    await audit(db, null, 'auto_mute_site', 'user', userId, { strikesLastHour: inHour, lastCode: code });
    await redis.del(key);
    return `You've been muted across the site for ${SITE_ROOMS.siteMuteMinutes} minutes for repeated rule-breaking.`;
  }

  if (roomId == null) return null;
  // Don't stack mutes: only add one if none is active in this room.
  const { rowCount } = await db.query(
    `INSERT INTO sanctions (user_id, kind, room_id, reason, issued_by, expires_at)
     SELECT $1, 'mute', $2, $3, NULL, now() + make_interval(mins => $4)
      WHERE NOT EXISTS (SELECT 1 FROM sanctions WHERE user_id = $1 AND kind = 'mute' AND room_id = $2
                          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))`,
    [userId, roomId, 'Automatic: repeated rule-breaking in this room', SITE_ROOMS.roomMuteMinutes],
  );
  if (!rowCount) return null;
  await audit(db, null, 'auto_mute_room', 'user', userId, { roomId, strikesInWindow: inWindow, lastCode: code });
  return `You've been muted in this room for ${SITE_ROOMS.roomMuteMinutes} minutes for repeated rule-breaking.`;
}
