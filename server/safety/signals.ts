import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { SAFETY } from '../../shared/config.js';
import { env } from '../env.js';
import { db, type Tx } from '../store.js';

/** HMAC so raw IPs and device ids are never stored, but equal inputs still match. */
export function signalHash(kind: string, value: string): string {
  return createHmac('sha256', env.signalSecret).update(`${kind}:${value}`).digest('base64url');
}

/**
 * Network prefix: IPv4 /24, IPv6 /48. Groups people on the same home or mobile
 * network without singling out one address (which changes often anyway).
 */
export function ipPrefix(ip: string): string {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIPv4(v4)) return v4.split('.').slice(0, 3).join('.') + '.0/24';
  if (isIPv6(ip)) {
    const [head] = ip.split('::');
    const groups = ip.includes('::')
      ? [...head.split(':').filter(Boolean), '0', '0', '0'].slice(0, 3)
      : ip.split(':').slice(0, 3);
    return groups.map((g) => g.toLowerCase()).join(':') + '::/48';
  }
  return 'unknown';
}

export interface ClientSignals {
  ip: string;
  /** Long-lived http-only cookie set by the server. */
  deviceCookie?: string;
  /** Random id the browser keeps in localStorage and sends as a header; survives cookie clearing. */
  clientStorageId?: string;
}

export type SignalKind = 'device' | 'ip_prefix' | 'ip';

/** Hash of one exact address, for admin bans (kept separate from the network-prefix hash). */
export const exactIpHash = (ip: string) => signalHash('ipx', ip.startsWith('::ffff:') ? ip.slice(7) : ip);

export function hashedSignals(s: ClientSignals): { hash: string; kind: SignalKind }[] {
  const out: { hash: string; kind: SignalKind }[] = [
    { hash: signalHash('ip', ipPrefix(s.ip)), kind: 'ip_prefix' },
    { hash: exactIpHash(s.ip), kind: 'ip' },
  ];
  for (const id of [s.deviceCookie, s.clientStorageId]) {
    if (id && /^[A-Za-z0-9_-]{16,64}$/.test(id)) out.push({ hash: signalHash('device', id), kind: 'device' });
  }
  return out;
}

export async function recordSignals(q: Tx | typeof db, userId: string, s: ClientSignals): Promise<void> {
  for (const { hash, kind } of hashedSignals(s)) {
    await q.query(
      `INSERT INTO device_signals (user_id, signal_hash, kind) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, signal_hash) DO UPDATE SET last_seen = now()`,
      [userId, hash, kind],
    );
  }
}

/**
 * Does this visitor share a device signal with an account under an active site-wide
 * ban or shadow-mute? Network-prefix matches alone are weaker evidence (shared Wi-Fi,
 * mobile carriers), so they only count together with a device match or when the
 * banned account used that network in the last 7 days.
 */
export async function matchesSanctionedAccount(s: ClientSignals, excludeUserId?: string): Promise<string | null> {
  const signals = hashedSignals(s);
  const device = signals.filter((x) => x.kind === 'device').map((x) => x.hash); // exact IPs aren't used here: prefixes cover networks
  const net = signals.filter((x) => x.kind === 'ip_prefix').map((x) => x.hash);
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT ds.user_id
       FROM device_signals ds
       JOIN sanctions s ON s.user_id = ds.user_id
      WHERE s.room_id IS NULL AND s.kind IN ('ban', 'shadow_mute')
        AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
        AND ($3::bigint IS NULL OR ds.user_id <> $3)
        AND (ds.signal_hash = ANY($1)
             OR (ds.signal_hash = ANY($2) AND ds.last_seen > now() - interval '7 days'))
      LIMIT 1`,
    [device, net, excludeUserId ?? null],
  );
  return rows[0]?.user_id ?? null;
}

export async function pruneOldSignals(): Promise<void> {
  await db.query(`DELETE FROM device_signals WHERE last_seen < now() - make_interval(days => $1)`, [
    SAFETY.signalRetentionDays,
  ]);
}
