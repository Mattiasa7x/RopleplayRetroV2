import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import { DEFAULT_PREFS, type Prefs } from '../shared/config.js';
import { effectivePrefs } from './account.js';
import { parse, requireUser } from './http.js';
import { db } from './store.js';

/**
 * Browser push notifications. The signing keys are made once and kept in the database,
 * so nothing needs configuring. Notifications only say who did what ("Sk8rJen sent you a
 * message"), never the words themselves, since they can show on a lock screen.
 */

let publicKey = '';
let ready = false;

export async function setupPush(log: (m: string) => void): Promise<void> {
  const { rows } = await db.query<{ key: string; value: string }>("SELECT key, value FROM app_secrets WHERE key IN ('vapid_public', 'vapid_private')");
  let pub = rows.find((r) => r.key === 'vapid_public')?.value;
  let priv = rows.find((r) => r.key === 'vapid_private')?.value;
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey;
    priv = k.privateKey;
    await db.query("INSERT INTO app_secrets (key, value) VALUES ('vapid_public', $1), ('vapid_private', $2) ON CONFLICT (key) DO NOTHING", [pub, priv]);
    const again = await db.query<{ key: string; value: string }>("SELECT key, value FROM app_secrets WHERE key IN ('vapid_public', 'vapid_private')");
    pub = again.rows.find((r) => r.key === 'vapid_public')!.value;
    priv = again.rows.find((r) => r.key === 'vapid_private')!.value;
    log('push notification keys created');
  }
  webpush.setVapidDetails(process.env.PUSH_CONTACT ?? 'https://roleplayretro.com', pub, priv);
  publicKey = pub;
  ready = true;
}

export type PushKind = 'dm' | 'mention' | 'friend' | 'comment';

/** Send a notification to every device where this member turned push on. Never throws. */
export function pushTo(userId: string, kind: PushKind, msg: { title: string; body?: string; url: string; tag?: string }): void {
  if (!ready) return;
  void (async () => {
    const { rows: u } = await db.query<{ prefs: Partial<Prefs>; birthdate: string | null }>('SELECT prefs, birthdate FROM users WHERE id = $1', [userId]);
    if (!u[0]) return;
    const p = effectivePrefs({ ...DEFAULT_PREFS, ...u[0].prefs });
    if (!p.pushAlerts) return;
    if (kind === 'mention' && !p.mentionAlerts) return;
    if ((kind === 'friend' || kind === 'comment') && !p.friendAlerts) return;
    const { rows } = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
    const payload = JSON.stringify({ title: msg.title, body: msg.body ?? '', url: msg.url, tag: msg.tag ?? kind });
    await Promise.all(rows.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: kind === 'dm' ? 'high' : 'normal' });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); // device unsubscribed
      }
    }));
  })().catch(() => {});
}

/** Browsers' push services. Anything else is refused, so the server never posts to an address a member picked. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.services\.mozilla\.com$/];
const isPushService = (u: string) => {
  try { const x = new URL(u); return x.protocol === 'https:' && !x.port && PUSH_HOSTS.some((r) => r.test(x.hostname)); } catch { return false; }
};
const SubBody = z.object({
  endpoint: z.string().url().max(1000).refine(isPushService, 'not a browser push service'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});
const EndpointBody = z.object({ endpoint: z.string().max(1000) });

export function registerPushRoutes(app: FastifyInstance) {
  app.get('/api/push/key', async (req) => {
    requireUser(req);
    return { key: publicKey };
  });

  /** This device wants notifications. */
  app.post('/api/push/subscribe', async (req) => {
    const u = requireUser(req);
    const b = parse(SubBody, req.body);
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [u.id, b.endpoint, b.keys.p256dh, b.keys.auth],
    );
    return { ok: true };
  });

  /** This device doesn't want them any more (or the member logged out). */
  app.post('/api/push/unsubscribe', async (req) => {
    const u = requireUser(req);
    const b = parse(EndpointBody, req.body);
    await db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [u.id, b.endpoint]);
    return { ok: true };
  });
}
