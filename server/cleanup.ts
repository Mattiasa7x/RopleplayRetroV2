import { INACTIVITY } from '../shared/config.js';
import { messenger } from './mail.js';
import { rooms as sockRooms, type IO } from './realtime.js';
import { audit, db, tx } from './store.js';

/**
 * Hourly: clear out what nobody uses.
 *   • Member rooms with no messages for INACTIVITY.roomDays are deleted (site and regional
 *     rooms never are).
 *   • Accounts nobody has signed in to for INACTIVITY.accountDays are deleted with all their
 *     data, after an email warning INACTIVITY.warnDaysBefore days earlier. The site owner's
 *     account and anyone with an active Gold Quill pass are never deleted this way.
 * A few at a time, so a big backlog never slows the site down.
 */
export async function runInactivityCleanup(io: IO, log: (m: string) => void): Promise<void> {
  // ----- rooms -----
  const { rows: stale } = await db.query<{ id: number; slug: string; name: string; owner_id: string | null }>(
    `SELECT r.id, r.slug, r.name, r.owner_id::text AS owner_id FROM rooms r
      WHERE r.kind = 'member'
        AND GREATEST(r.created_at, COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.room_id = r.id), r.created_at))
            < now() - make_interval(days => $1)
      LIMIT 50`, [INACTIVITY.roomDays]);
  for (const r of stale) {
    io.to(sockRooms.chat(r.id)).emit('kicked', { roomId: r.id, reason: 'This room was closed after a week without messages.', minutes: 0 });
    io.in(sockRooms.chat(r.id)).socketsLeave(sockRooms.chat(r.id));
    await tx(async (q) => {
      await audit(q, null, 'room_expired', 'room', String(r.id), { slug: r.slug, name: r.name, owner: r.owner_id });
      await q.query("DELETE FROM rooms WHERE id = $1 AND kind = 'member'", [r.id]);
    });
    if (r.owner_id) io.to(sockRooms.user(r.owner_id)).emit('notice', { message: `Your room "${r.name}" was closed after ${INACTIVITY.roomDays} days without messages.` });
  }
  if (stale.length) log(`inactivity: closed ${stale.length} member room(s) with no messages for ${INACTIVITY.roomDays} days`);

  // Never touched: the site owner, and anyone with an active paid pass.
  const keep = `u.id::text IS DISTINCT FROM (SELECT value FROM app_secrets WHERE key = 'admin_user_id')
                AND (u.quill_until IS NULL OR u.quill_until <= now())`;

  // ----- accounts: warn first -----
  const warnAfter = INACTIVITY.accountDays - INACTIVITY.warnDaysBefore;
  const { rows: toWarn } = await db.query<{ id: string; handle: string; email: string; last_active_at: Date }>(
    `SELECT u.id::text AS id, u.handle, u.email, u.last_active_at FROM users u
      WHERE u.last_active_at < now() - make_interval(days => $1) AND u.inactivity_warned_at IS NULL
        AND u.email_verified_at IS NOT NULL AND ${keep}
      ORDER BY u.last_active_at LIMIT 25`, [warnAfter]);
  let warned = 0;
  for (const u of toWarn) {
    // Always give them the full warning period from the day the email goes out.
    const deleteOn = new Date(Math.max(new Date(u.last_active_at).getTime() + INACTIVITY.accountDays * 86_400_000,
      Date.now() + INACTIVITY.warnDaysBefore * 86_400_000));
    try {
      await messenger().sendInactivityWarning(u.email, u.handle, deleteOn);
      await db.query('UPDATE users SET inactivity_warned_at = now() WHERE id = $1', [u.id]);
      warned++;
    } catch { /* mail trouble: try again next hour */ }
  }
  if (warned) log(`inactivity: warned ${warned} account(s) by email`);

  // ----- accounts: delete -----
  // Past the two years, and either warned at least the warning period ago or impossible to warn
  // (no confirmed email).
  const { rows: gone } = await db.query<{ id: string; handle: string }>(
    `SELECT u.id::text AS id, u.handle FROM users u
      WHERE u.last_active_at < now() - make_interval(days => $1)
        AND (u.email_verified_at IS NULL OR u.inactivity_warned_at < now() - make_interval(days => $2))
        AND ${keep}
      ORDER BY u.last_active_at LIMIT 25`, [INACTIVITY.accountDays, INACTIVITY.warnDaysBefore]);
  for (const u of gone) {
    io.in(sockRooms.user(u.id)).disconnectSockets(true);
    await tx(async (q) => {
      await audit(q, null, 'account_expired', 'user', u.id, { handle: u.handle });
      // Same as deleting your own account: everything goes, and the name stays reserved.
      await q.query('DELETE FROM users WHERE id = $1', [u.id]);
    });
  }
  if (gone.length) log(`inactivity: deleted ${gone.length} account(s) unused for ${INACTIVITY.accountDays} days`);
}
