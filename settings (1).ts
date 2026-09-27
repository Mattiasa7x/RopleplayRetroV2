import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COMMENT_PERMISSION, FRIEND_REQUESTS, PASSWORD_MIN, SITE_NAME, TEXT_SIZES, THEMES, VISIBILITY, type Prefs } from '../shared/config.js';
import type { SessionInfo } from '../shared/types.js';
import { lockedChanges } from './account.js';
import { checkSecondFactor, hashPassword, issueCode, meDTO, sha256, verifyPassword } from './auth.js';
import { HttpError, parse, requireUser } from './http.js';
import { disconnectUser, setFilterGroup, type IO } from './realtime.js';
import { slidingWindow } from './safety/limits.js';
import { audit, db, redis, tx } from './store.js';
import { newBackupCodes, newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

const PrefsBody = z
  .object({
    theme: z.enum(THEMES),
    textSize: z.enum(TEXT_SIZES),
    chatFilter: z.boolean(),
    profileVisibility: z.enum(VISIBILITY),
    whoCanComment: z.enum(COMMENT_PERMISSION),
    whoCanFriend: z.enum(FRIEND_REQUESTS),
    showOnline: z.boolean(),
    mentionAlerts: z.boolean(),
    friendAlerts: z.boolean(),
    enterToSend: z.boolean(),
    showTimestamps: z.boolean(),
  })
  .partial()
  .strict();

const PasswordBody = z.object({ current: z.string().min(1).max(200), next: z.string().min(PASSWORD_MIN, `at least ${PASSWORD_MIN} characters`).max(200) });
const EmailBody = z.object({ password: z.string().min(1).max(200), email: z.string().trim().toLowerCase().email().max(254) });
const PasswordOnly = z.object({ password: z.string().min(1).max(200) });
const CodeBody = z.object({ code: z.string().trim().min(6).max(12) });
const DisableBody = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(12) });
const DeleteBody = z.object({ password: z.string().min(1).max(200), confirmHandle: z.string() });

async function assertPassword(userId: string, password: string) {
  if (!(await slidingWindow(redis, `pwcheck:${userId}`, 10, 15 * 60_000))) {
    throw new HttpError(429, 'pw_rate', 'Too many attempts. Wait 15 minutes.');
  }
  const { rows } = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !(await verifyPassword(password, rows[0].password_hash))) throw new HttpError(401, 'bad_password', 'Your current password is wrong.');
}

export function registerSettingsRoutes(app: FastifyInstance, io: IO) {
  // ----- preferences (appearance, chat filter, privacy, notifications) -----
  app.patch('/api/me/prefs', async (req) => {
    const u = requireUser(req);
    const patch = parse(PrefsBody, req.body) as Partial<Prefs>;
    const locked = lockedChanges(patch, u.isMinor);
    if (locked.length) {
      throw new HttpError(403, 'locked', 'This setting is locked on for members under 18.');
    }
    await db.query('UPDATE users SET prefs = prefs || $2::jsonb WHERE id = $1', [u.id, JSON.stringify(patch)]);
    if (patch.chatFilter !== undefined) setFilterGroup(io, u.id, patch.chatFilter || u.isMinor);
    return meDTO({ ...u, prefs: { ...u.prefs, ...patch } });
  });

  // ----- password -----
  app.post('/api/me/password', async (req) => {
    const u = requireUser(req);
    const b = parse(PasswordBody, req.body);
    await assertPassword(u.id, b.current);
    if (b.current === b.next) throw new HttpError(400, 'same', 'Pick a password you have not used here.');
    await tx(async (q) => {
      await q.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [u.id, await hashPassword(b.next)]);
      // Changing the password signs out every other device.
      await q.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [u.id, u.sessionId]);
      await audit(q, u.id, 'password_change', 'user', u.id);
    });
    return { ok: true };
  });

  // ----- email -----
  app.post('/api/me/email', async (req) => {
    const u = requireUser(req);
    const b = parse(EmailBody, req.body);
    await assertPassword(u.id, b.password);
    try {
      await db.query('UPDATE users SET email = $2, email_verified_at = NULL WHERE id = $1', [u.id, b.email]);
    } catch (e) {
      if ((e as { constraint?: string }).constraint === 'users_email_lower') throw new HttpError(409, 'email_taken', 'That email is already used by another account.');
      throw e;
    }
    await audit(db, u.id, 'email_change', 'user', u.id);
    await issueCode(u.id, b.email);
    return { ok: true };
  });

  // ----- signed-in devices -----
  app.get('/api/me/sessions', async (req): Promise<SessionInfo[]> => {
    const u = requireUser(req);
    const { rows } = await db.query<{ id: string; created_at: Date; expires_at: Date }>(
      'SELECT id, created_at, expires_at FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC',
      [u.id],
    );
    return rows.map((r) => ({
      id: r.id.slice(0, 10), createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(), current: r.id === u.sessionId,
    }));
  });

  app.delete<{ Params: { id: string } }>('/api/me/sessions/:id', async (req) => {
    const u = requireUser(req);
    if (!/^[A-Za-z0-9_-]{10}$/.test(req.params.id)) throw new HttpError(404, 'no_session', 'Not found.');
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND left(id, 10) = $2 AND id <> $3', [u.id, req.params.id, u.sessionId]);
    return { ok: true };
  });

  app.post('/api/me/sessions/sign-out-others', async (req) => {
    const u = requireUser(req);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [u.id, u.sessionId]);
    await audit(db, u.id, 'sign_out_others', 'user', u.id);
    return { ok: true };
  });

  // ----- two-factor authentication -----
  app.post('/api/me/2fa/setup', async (req) => {
    const u = requireUser(req);
    const { password } = parse(PasswordOnly, req.body);
    await assertPassword(u.id, password);
    if (u.twoFactor) throw new HttpError(400, 'already', 'Two-factor sign-in is already on.');
    const secret = newTotpSecret();
    await db.query('UPDATE users SET totp_secret = $2 WHERE id = $1', [u.id, secret]);
    return { secret, uri: otpauthUri(secret, u.handle, SITE_NAME) };
  });

  app.post('/api/me/2fa/enable', async (req) => {
    const u = requireUser(req);
    const { code } = parse(CodeBody, req.body);
    const { rows } = await db.query<{ totp_secret: string | null }>('SELECT totp_secret FROM users WHERE id = $1', [u.id]);
    if (!rows[0]?.totp_secret) throw new HttpError(400, 'no_setup', 'Start setup first.');
    if (!verifyTotp(rows[0].totp_secret, code)) throw new HttpError(400, 'code_wrong', 'That code is not right. Check the time on your phone.');
    const codes = newBackupCodes();
    await tx(async (q) => {
      await q.query('UPDATE users SET totp_enabled = true WHERE id = $1', [u.id]);
      await q.query('DELETE FROM backup_codes WHERE user_id = $1', [u.id]);
      for (const c of codes) {
        await q.query('INSERT INTO backup_codes (user_id, code_hash) VALUES ($1, $2)', [u.id, sha256(`${u.id}:${c.replace('-', '')}`)]);
      }
      await audit(q, u.id, '2fa_enable', 'user', u.id);
    });
    return { backupCodes: codes }; // shown once
  });

  app.post('/api/me/2fa/disable', async (req) => {
    const u = requireUser(req);
    const b = parse(DisableBody, req.body);
    await assertPassword(u.id, b.password);
    if (!(await checkSecondFactor(u.id, b.code))) throw new HttpError(400, 'code_wrong', 'That code is not right.');
    await tx(async (q) => {
      await q.query('UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1', [u.id]);
      await q.query('DELETE FROM backup_codes WHERE user_id = $1', [u.id]);
      await audit(q, u.id, '2fa_disable', 'user', u.id);
    });
    return { ok: true };
  });

  // ----- delete account -----
  app.post('/api/me/delete', async (req, reply) => {
    const u = requireUser(req);
    const b = parse(DeleteBody, req.body);
    if (b.confirmHandle !== u.handle) throw new HttpError(400, 'confirm', 'Type your name exactly to confirm.');
    await assertPassword(u.id, b.password);
    // A banned or sanctioned account can't delete itself to wipe its record and start over.
    const { rowCount: sanctioned } = await db.query(
      `SELECT 1 FROM sanctions WHERE user_id = $1 AND room_id IS NULL AND kind IN ('ban', 'shadow_mute', 'mute')
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [u.id],
    );
    if (sanctioned) throw new HttpError(403, 'sanctioned', 'Accounts with an active site-wide sanction cannot be deleted. Contact the moderators.');
    await tx(async (q) => {
      await audit(q, u.id, 'account_delete', 'user', u.id, { handle: u.handle });
      // The database reserves this name's skeleton forever (users_reserve_on_delete trigger).
      await q.query('DELETE FROM users WHERE id = $1', [u.id]);
    });
    disconnectUser(io, u.id);
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });
}
