import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Trust } from '../shared/config.js';
import { QUILL_NAME, QUILL_PASS_BY_ID, quillActive, type QuillPassId } from '../shared/quill.js';
import type { QuillStatusDTO } from '../shared/types.js';
import { env } from './env.js';
import { HttpError, parse, requireUser, type SessionUser } from './http.js';
import { audit, db, tx } from './store.js';

/**
 * Gold Quill passes, paid through PayPal (Orders API v2, full-page redirect: no PayPal
 * scripts on our pages, so the site's strict security policy stays as it is).
 *
 *   1. POST /api/quill/checkout {pass}  → we create the order at PayPal with the price from
 *      shared/quill.ts (never from the browser) and send the member to PayPal to approve it.
 *   2. PayPal sends them back to /gold-quill/return?token=<order id>.
 *   3. POST /api/quill/capture {orderId} → we capture it at PayPal, check it's COMPLETED for the
 *      right amount, currency and account, and only then add the time (see the database's
 *      users_quill_paid trigger: nothing else can grant Gold Quill).
 */

export const isQuill = (u: SessionUser) => quillActive(u.quillUntil);

const API = () => (env.paypalEnv === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
export const paypalConfigured = () => !!(env.paypalClientId && env.paypalSecret);

let token: { value: string; until: number } | null = null;
let lastTokenError = '';
async function paypalToken(): Promise<string> {
  if (token && token.until > Date.now() + 60_000) return token.value;
  let res: Response;
  try {
    res = await fetch(`${API()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.paypalClientId}:${env.paypalSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    lastTokenError = `network: ${(e as Error).message}`;
    throw new HttpError(502, 'paypal', 'PayPal is not reachable right now. Please try again in a few minutes.');
  }
  if (!res.ok) {
    // e.g. 401 invalid_client: wrong keys, or live keys with PAYPAL_ENV not set to live.
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    lastTokenError = `${res.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim();
    throw new HttpError(503, 'paypal_setup', 'Payments are being set up. Please try again later.');
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, until: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function paypal<T>(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await paypalToken()}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

interface PaypalOrder {
  id: string;
  status: string;
  links?: { href: string; rel: string }[];
  details?: { issue: string }[];
  purchase_units?: {
    custom_id?: string;
    amount?: { currency_code: string; value: string };
    payments?: { captures?: { id: string; status: string; amount: { currency_code: string; value: string }; custom_id?: string }[] };
  }[];
}

interface OrderRow { id: string; user_id: string; pass: QuillPassId; amount: string; currency: string; status: string }

/** Grant the time for a captured order, once. Returns the new end of the pass. */
async function grant(order: OrderRow, captureId: string): Promise<string> {
  const pass = QUILL_PASS_BY_ID.get(order.pass)!;
  return tx(async (q) => {
    // Lock the member and the order so a double return from PayPal can't grant twice.
    const { rows: u } = await q.query<{ quill_until: Date | null }>('SELECT quill_until FROM users WHERE id = $1 FOR UPDATE', [order.user_id]);
    const { rows: o } = await q.query<{ status: string; granted_until: Date | null }>('SELECT status, granted_until FROM quill_orders WHERE id = $1 FOR UPDATE', [order.id]);
    if (o[0]?.status === 'completed') return o[0].granted_until!.toISOString();
    const base = Math.max(Date.now(), u[0]?.quill_until ? new Date(u[0].quill_until).getTime() : 0);
    const until = new Date(base + pass.days * 86_400_000);
    await q.query(
      `UPDATE quill_orders SET status = 'completed', capture_id = $2, granted_until = $3, completed_at = now() WHERE id = $1`,
      [order.id, captureId, until],
    );
    await q.query('UPDATE users SET quill_until = $2 WHERE id = $1', [order.user_id, until]);
    await audit(q, order.user_id, 'quill_purchase', 'user', order.user_id, { order: order.id, pass: order.pass, amount: order.amount });
    return until.toISOString();
  });
}

/** Check a PayPal order (captured or fetched) really is this member's payment for this pass. */
function checkCaptured(order: OrderRow, p: PaypalOrder): { ok: true; captureId: string } | { ok: false; pending: boolean } {
  const unit = p.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  if (!cap) return { ok: false, pending: false };
  const custom = cap.custom_id ?? unit?.custom_id;
  const right = cap.amount.currency_code === order.currency && Number(cap.amount.value) === Number(order.amount)
    && custom === `${order.user_id}:${order.pass}`;
  if (!right) return { ok: false, pending: false };
  if (cap.status === 'COMPLETED') return { ok: true, captureId: cap.id };
  return { ok: false, pending: cap.status === 'PENDING' };
}

async function status(u: SessionUser): Promise<QuillStatusDTO> {
  const { rows: me } = await db.query<{ quill_until: Date | null }>('SELECT quill_until FROM users WHERE id = $1', [u.id]);
  const { rows } = await db.query<{ id: string; pass: QuillPassId; amount: string; status: string; created_at: Date; granted_until: Date | null }>(
    `SELECT id, pass, amount::text AS amount, status, created_at, granted_until FROM quill_orders
      WHERE user_id = $1 AND status IN ('completed', 'pending') ORDER BY created_at DESC LIMIT 50`, [u.id]);
  const until = me[0]?.quill_until ?? null;
  return {
    active: quillActive(until),
    until: until ? new Date(until).toISOString() : null,
    available: paypalConfigured(),
    sandbox: env.paypalEnv !== 'live',
    history: rows.map((r) => ({
      orderId: r.id, pass: r.pass, amount: r.amount, status: r.status as 'completed' | 'pending',
      date: r.created_at.toISOString(), until: r.granted_until?.toISOString() ?? null,
    })),
  };
}

const CheckoutBody = z.object({ pass: z.enum(['day', 'week', 'month']) });
const CaptureBody = z.object({ orderId: z.string().regex(/^[A-Z0-9]{5,40}$/) });

/** On start: sign in to PayPal once and say in the log whether it worked (never logs the keys). */
export async function checkPaypal(log: (m: string) => void): Promise<void> {
  if (!paypalConfigured()) { log('PayPal: not set up (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET empty); passes show "Coming soon"'); return; }
  const id = env.paypalClientId;
  try {
    await paypalToken();
    log(`PayPal (${env.paypalEnv}): connected, client id ${id.slice(0, 6)}…${id.slice(-4)}`);
  } catch {
    log(`PayPal (${env.paypalEnv}): keys refused: ${lastTokenError}. Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, and that PAYPAL_ENV is "${env.paypalEnv === 'live' ? 'sandbox' : 'live'}" if these are ${env.paypalEnv === 'live' ? 'sandbox' : 'live'} keys (client id ${id.slice(0, 6)}…${id.slice(-4)}, ${id.length} chars)`);
  }
}

export function registerQuillRoutes(app: FastifyInstance) {
  app.get('/api/quill', async (req, reply): Promise<QuillStatusDTO> => {
    reply.header('Cache-Control', 'no-store, private');
    return status(requireUser(req));
  });

  app.post('/api/quill/checkout', async (req) => {
    const u = requireUser(req, Trust.Verified);
    if (!paypalConfigured()) throw new HttpError(503, 'paypal_off', `${QUILL_NAME} passes aren't on sale yet. Check back soon.`);
    const pass = QUILL_PASS_BY_ID.get(parse(CheckoutBody, req.body).pass)!;
    const { status: code, data } = await paypal<PaypalOrder>('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: pass.id,
        custom_id: `${u.id}:${pass.id}`,
        description: `RoleplayRetro ${QUILL_NAME} ${pass.label} (${pass.days} day${pass.days === 1 ? '' : 's'})`,
        amount: { currency_code: 'USD', value: pass.price },
      }],
      payment_source: { paypal: { experience_context: {
        brand_name: 'RoleplayRetro',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
        return_url: `${env.siteUrl}/gold-quill/return`,
        cancel_url: `${env.siteUrl}/gold-quill?cancelled=1`,
      } } },
    });
    const approve = data.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    if (code >= 300 || !data.id || !approve) {
      req.log.error({ code, data }, 'paypal order failed');
      throw new HttpError(502, 'paypal', 'PayPal could not start the checkout. Please try again.');
    }
    await db.query('INSERT INTO quill_orders (id, user_id, pass, amount) VALUES ($1, $2, $3, $4)', [data.id, u.id, pass.id, pass.price]);
    return { url: approve };
  });

  /** Back from PayPal: capture the payment and add the time. Safe to call twice. */
  app.post('/api/quill/capture', async (req) => {
    const u = requireUser(req);
    const { orderId } = parse(CaptureBody, req.body);
    const { rows } = await db.query<OrderRow>(
      'SELECT id, user_id::text AS user_id, pass, amount::text AS amount, currency, status FROM quill_orders WHERE id = $1 AND user_id = $2',
      [orderId, u.id]);
    const order = rows[0];
    if (!order) throw new HttpError(404, 'no_order', "We couldn't find that purchase on your account.");
    if (order.status === 'completed') return { ok: true, ...(await status(u)) };

    let res = await paypal<PaypalOrder>('POST', `/v2/checkout/orders/${orderId}/capture`, {}, `capture-${orderId}`);
    // Already captured (e.g. a second tap), or still pending: look the order up instead.
    if (res.status === 422 || res.status >= 500) res = await paypal<PaypalOrder>('GET', `/v2/checkout/orders/${orderId}`);
    const check = checkCaptured(order, res.data);
    if (check.ok) {
      await grant(order, check.captureId);
      return { ok: true, ...(await status(u)) };
    }
    if (check.pending) {
      await db.query("UPDATE quill_orders SET status = 'pending' WHERE id = $1 AND status <> 'completed'", [orderId]);
      return { ok: false, pending: true, message: 'PayPal is still processing this payment. Your pass starts as soon as it clears: check Settings › Subscriptions.' };
    }
    if (res.data.status === 'APPROVED' || res.data.status === 'CREATED' || res.data.status === 'PAYER_ACTION_REQUIRED') {
      return { ok: false, message: "The payment wasn't finished at PayPal, so you haven't been charged." };
    }
    await db.query("UPDATE quill_orders SET status = 'failed' WHERE id = $1 AND status = 'created'", [orderId]);
    req.log.warn({ orderId, paypal: res.data.status }, 'quill capture not completed');
    return { ok: false, message: "PayPal didn't complete this payment, so you haven't been charged." };
  });
}
