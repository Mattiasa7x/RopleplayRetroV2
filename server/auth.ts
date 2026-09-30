import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AGE, HANDLE_PATTERN, PASSWORD_MIN, SAFETY, SITE_NAME, TERMS_VERSION, Trust } from '../shared/config.js';
import { isReservedHandle } from '../shared/handles.js';
import type { LoginResult, MeDTO } from '../shared/types.js';
import { ageOn, effectivePrefs, isUnderage } from './account.js';
import { env } from './env.js';
import { HttpError, clientSignals, parse, requireUser, type SessionUser } from './http.js';
import { MailError, messenger } from './mail.js';
import { bumpDaily, slidingWindow, underDailyCap } from './safety/limits.js';
import { ipPrefix, matchesSanctionedAccount, recordSignals, signalHash } from './safety/signals.js';
import { audit, db, redis, tx, type Tx } from './store.js';
import { verifyTotp } from './totp.js';
import { afterInviteeConfirmed, afterSecurityChange } from './trophies.js';
import { normalizeInviteCode } from '../shared/trophies.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Built-in scrypt keeps the starter free of native modules. Argon2id (e.g. @node-rs/argon2)
// is a drop-in upgrade: verifyPassword can recognise both formats during migration.
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64url');
  const got = await scrypt(pw, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(got, expected);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');

const DISPOSABLE = new Set(
  readFileSync(resolve(process.env.DISPOSABLE_DOMAINS_PATH ?? 'server/safety/disposable-domains.txt'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim().toLowerCase())
    .filter(Boolean),
);

// ---------- sessions ----------

export async function createSession(q: Tx | typeof db, userId: string, ip: string, device?: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await q.query(
    `INSERT INTO sessions (id, user_id, expires_at, ip_prefix, device_hash)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [sha256(token), userId, SAFETY.sessionDays, signalHash('ip', ipPrefix(ip)), device ? signalHash('device', device) : null],
  );
  return token;
}

export async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.handle, u.trust_level, u.email, u.email_verified_at, u.prefs, u.birthdate, u.totp_enabled, u.quill_until, u.last_active_at, s.id AS sid
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r || isUnderage(r.birthdate)) return null; // adults only
  // Remember they're still around (for the 2-year inactivity rule); at most every few hours.
  if (!r.last_active_at || Date.now() - new Date(r.last_active_at).getTime() > 3 * 3600_000) {
    void db.query('UPDATE users SET last_active_at = now(), inactivity_warned_at = NULL WHERE id = $1', [r.id]).catch(() => {});
  }
  return {
    id: r.id, handle: r.handle, trust: r.trust_level, email: r.email,
    emailVerified: !!r.email_verified_at, prefs: effectivePrefs(r.prefs),
    twoFactor: r.totp_enabled, sessionId: r.sid,
    quillUntil: r.quill_until ? new Date(r.quill_until).toISOString() : null,
  };
}

/** Pull the session token out of a raw Cookie header (used by the socket handshake). */
export function tokenFromCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'sid') return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    path: '/',
    maxAge: SAFETY.sessionDays * 24 * 3600,
  });
}

// ---------- verification codes ----------

export async function issueCode(userId: string, email: string): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(
    `INSERT INTO verification_codes (user_id, channel, code_hash, expires_at, attempts)
     VALUES ($1, 'email', $2, now() + make_interval(mins => $3), 0)
     ON CONFLICT (user_id, channel) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
    [userId, sha256(`${userId}:${code}`), SAFETY.verificationCodeMinutes],
  );
  try {
    await messenger().sendEmailCode(email, code);
  } catch (e) {
    if (e instanceof MailError) throw new HttpError(503, 'mail_failed', e.message);
    throw e;
  }
}

// ---------- routes ----------

const SignupBody = z.object({
  handle: z.string().regex(HANDLE_PATTERN, '3–16 letters, digits or underscores'),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(PASSWORD_MIN, `at least ${PASSWORD_MIN} characters`).max(200),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2001-06-30'),
  /** Optional: someone's invite code (dash and case don't matter). */
  inviteCode: z.string().max(20).optional(),
  /** Creating an account means agreeing to the Terms of Service (the note under the button). */
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'Please agree to the Terms of Service to create an account.' }) }),
});
const LoginBody = z.object({ handle: z.string().min(1).max(16), password: z.string().min(1).max(200) });
const TwoFactorBody = z.object({ ticket: z.string().min(20).max(64), code: z.string().trim().min(6).max(12) });
const VerifyBody = z.object({ code: z.string().regex(/^\d{6}$/, 'six digits') });

export async function meDTO(u: SessionUser): Promise<MeDTO> {
  const { rows } = await db.query<{ room_id: number }>('SELECT room_id FROM room_moderators WHERE user_id = $1', [u.id]);
  return {
    id: u.id, handle: u.handle, trust: u.trust, email: u.email, emailVerified: u.emailVerified, prefs: u.prefs,
    twoFactor: u.twoFactor,
    moderates: rows.map((r) => r.room_id),
    quillUntil: u.quillUntil,
  };
}

/** Check a 2FA code: an authenticator code, or an unused backup code (which is then spent). */
export async function checkSecondFactor(userId: string, code: string): Promise<boolean> {
  const { rows } = await db.query<{ totp_secret: string | null; totp_enabled: boolean }>('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u?.totp_enabled || !u.totp_secret) return false;
  if (/^\d{6}$/.test(code)) return verifyTotp(u.totp_secret, code);
  const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.length !== 8) return false;
  const used = await db.query(
    `UPDATE backup_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING 1`,
    [userId, sha256(`${userId}:${normalized}`)],
  );
  return !!used.rowCount;
}

async function finishLogin(req: Parameters<typeof clientSignals>[0], reply: FastifyReply, userId: string, trust: number): Promise<MeDTO> {
  const signals = clientSignals(req);
  await recordSignals(db, userId, signals);
  const matched = await matchesSanctionedAccount(signals, userId);
  if (matched && trust < Trust.Established) {
    await db.query('UPDATE users SET needs_review = true WHERE id = $1 AND NOT needs_review', [userId]);
    await audit(db, null, 'flag_shared_signals', 'user', userId, { matchedUserId: matched });
  }
  const token = await createSession(db, userId, req.ip, signals.deviceCookie);
  setSessionCookie(reply, token);
  return meDTO((await userFromToken(token))!);
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post('/api/signup', async (req, reply) => {
    const body = parse(SignupBody, req.body);
    const signals = clientSignals(req);
    const net = signalHash('ip', ipPrefix(req.ip));

    const born = new Date(`${body.birthdate}T00:00:00Z`);
    if (Number.isNaN(born.getTime()) || born > new Date() || ageOn(born) > 120) throw new HttpError(400, 'birthdate', 'Enter a real birthdate.');
    if (ageOn(born) < AGE.minimum) throw new HttpError(403, 'too_young', `${SITE_NAME} is for adults only. You must be ${AGE.minimum} or older to join.`);
    if (isReservedHandle(body.handle)) throw new HttpError(409, 'handle_reserved', 'That name is reserved. Please pick another.');

    if (!(await underDailyCap(redis, `signup:${net}`, SAFETY.signupsPerNetworkPerDay))) {
      throw new HttpError(429, 'signup_cap', 'Too many new accounts from this network today. Try again tomorrow.');
    }
    const domain = body.email.split('@')[1];
    if (DISPOSABLE.has(domain)) throw new HttpError(400, 'disposable_email', 'Please use a permanent email address.');

    let invitedBy: string | null = null;
    const invite = normalizeInviteCode(body.inviteCode ?? '');
    if (invite) {
      const { rows } = await db.query<{ id: string }>('SELECT id::text AS id FROM users WHERE invite_code = $1', [invite]);
      if (!rows[0]) throw new HttpError(400, 'bad_invite', "That invite code doesn't match anyone. Check it, or leave it blank.");
      invitedBy = rows[0].id;
    }

    const password = await hashPassword(body.password);
    const matched = await matchesSanctionedAccount(signals);

    const { userId, token } = await tx(async (q) => {
      let userId: string;
      try {
        const { rows } = await q.query<{ id: string }>(
          `INSERT INTO users (handle, email, password_hash, needs_review, birthdate, password_changed_at, invited_by, terms_version, terms_accepted_at)
           VALUES ($1, $2, $3, $4, $5, now(), $6, $7, now()) RETURNING id`,
          [body.handle, body.email, password, !!matched, body.birthdate, invitedBy, TERMS_VERSION],
        );
        userId = rows[0].id;
      } catch (e) {
        const c = (e as { constraint?: string }).constraint;
        if (c === 'users_handle_lower' || c === 'users_handle_skeleton' || c === 'handle_reserved') {
          throw new HttpError(409, 'handle_taken', 'That name is taken or looks too much like an existing name. Please pick another.');
        }
        if (c === 'users_email_lower') throw new HttpError(409, 'email_taken', 'That email already has an account. Try logging in.');
        throw e;
      }
      await recordSignals(q, userId, signals);
      if (matched) {
        // Ban evasion: don't tip them off. Shadow-mute and queue for a human to review.
        await q.query(
          `INSERT INTO sanctions (user_id, kind, room_id, reason, issued_by) VALUES ($1, 'shadow_mute', NULL, $2, NULL)`,
          [userId, 'Automatic: shares signals with a banned account'],
        );
        await audit(q, null, 'auto_shadow_mute', 'user', userId, { matchedUserId: matched });
      }
      await audit(q, userId, 'signup', 'user', userId);
      const token = await createSession(q, userId, req.ip, signals.deviceCookie);
      return { userId, token };
    });

    await bumpDaily(redis, `signup:${net}`);
    // The account exists either way; if the email didn't go, "Send a new code" on the next page retries.
    await issueCode(userId, body.email).catch((e) => console.error('[mail] signup code not sent:', (e as Error).message));
    setSessionCookie(reply, token);
    const me = await userFromToken(token);
    return reply.status(201).send(await meDTO(me!));
  });

  app.post('/api/login', async (req, reply): Promise<LoginResult> => {
    const body = parse(LoginBody, req.body);
    const key = `login:${signalHash('ip', ipPrefix(req.ip))}:${body.handle.toLowerCase()}`;
    if (!(await slidingWindow(redis, key, SAFETY.loginAttemptsPer15Min, 15 * 60_000))) {
      throw new HttpError(429, 'login_rate', 'Too many attempts. Wait 15 minutes and try again.');
    }
    const { rows } = await db.query('SELECT id, password_hash, trust_level, totp_enabled, birthdate FROM users WHERE lower(handle) = lower($1)', [body.handle]);
    const u = rows[0];
    // Same message whether the handle or the password was wrong.
    if (!u || !(await verifyPassword(body.password, u.password_hash))) {
      throw new HttpError(401, 'bad_login', 'Name or password is wrong.');
    }
    if (isUnderage(u.birthdate)) throw new HttpError(403, 'adults_only', `${SITE_NAME} is for adults only (${AGE.minimum}+).`);
    if (u.totp_enabled) {
      // Password was right; hold a short-lived ticket until the second factor arrives.
      const ticket = randomBytes(24).toString('base64url');
      await redis.set(`2fa:${ticket}`, JSON.stringify({ userId: u.id, trust: u.trust_level, tries: 0 }), 'EX', 300);
      return { twoFactorTicket: ticket };
    }
    return { me: await finishLogin(req, reply, u.id, u.trust_level) };
  });

  app.post('/api/login/2fa', async (req, reply): Promise<LoginResult> => {
    const { ticket, code } = parse(TwoFactorBody, req.body);
    const raw = await redis.get(`2fa:${ticket}`);
    if (!raw) throw new HttpError(401, 'ticket', 'That sign-in expired. Enter your password again.');
    const t = JSON.parse(raw) as { userId: string; trust: number; tries: number };
    if (!(await checkSecondFactor(t.userId, code))) {
      t.tries++;
      if (t.tries >= 5) await redis.del(`2fa:${ticket}`);
      else await redis.set(`2fa:${ticket}`, JSON.stringify(t), 'KEEPTTL');
      throw new HttpError(401, 'code_wrong', t.tries >= 5 ? 'Too many wrong codes. Sign in again.' : 'That code is not right.');
    }
    await redis.del(`2fa:${ticket}`);
    return { me: await finishLogin(req, reply, t.userId, t.trust) };
  });

  app.post('/api/logout', async (req, reply) => {
    if (req.user) await db.query('DELETE FROM sessions WHERE id = $1', [req.user.sessionId]);
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => meDTO(requireUser(req)));

  app.post('/api/verify/email', async (req) => {
    const u = requireUser(req);
    const { code } = parse(VerifyBody, req.body);
    const { rows } = await db.query(
      `UPDATE verification_codes SET attempts = attempts + 1
        WHERE user_id = $1 AND channel = 'email' RETURNING code_hash, expires_at, attempts`,
      [u.id],
    );
    const v = rows[0];
    if (!v) throw new HttpError(400, 'no_code', 'Request a new code first.');
    if (v.attempts > SAFETY.verificationMaxAttempts) throw new HttpError(429, 'code_attempts', 'Too many tries. Request a new code.');
    if (new Date(v.expires_at) < new Date()) throw new HttpError(400, 'code_expired', 'That code expired. Request a new one.');
    const ok = timingSafeEqual(Buffer.from(v.code_hash), Buffer.from(sha256(`${u.id}:${code}`)));
    if (!ok) throw new HttpError(400, 'code_wrong', 'That code is not right.');
    await tx(async (q) => {
      await q.query(`DELETE FROM verification_codes WHERE user_id = $1 AND channel = 'email'`, [u.id]);
      await q.query(
        `UPDATE users SET email_verified_at = now(), trust_level = GREATEST(trust_level, $2) WHERE id = $1`,
        [u.id, Trust.Verified],
      );
      await audit(q, u.id, 'email_verified', 'user', u.id);
    });
    afterSecurityChange(u.id);
    void afterInviteeConfirmed(u.id).catch((e) => console.error(e)); // an invite only counts once confirmed
    return { ok: true };
  });

  app.post('/api/verify/resend', async (req) => {
    const u = requireUser(req);
    if (u.emailVerified) return { ok: true };
    if (!(await slidingWindow(redis, `resend:${u.id}`, 3, 3600_000))) {
      throw new HttpError(429, 'resend_rate', 'You can request 3 codes an hour.');
    }
    await issueCode(u.id, u.email);
    return { ok: true };
  });
}
