import { readFileSync } from 'node:fs';
import { SAFETY, Trust } from '../../shared/config.js';

/**
 * VPN guard. Keeps a list of known VPN address ranges (X4BNet lists_vpn, MIT licence) in
 * memory, refreshed daily from GitHub with a bundled copy as the fallback, and answers
 * "is this address a VPN?" in microseconds. Addresses are only checked, never stored.
 *
 * It applies to new sign-ups and, after that, only to accounts that are new (the first
 * SAFETY.vpnNewAccountDays days) or that have been banned before. The site admin never is.
 * If the list can't be loaded at all, nobody is blocked (fail open).
 */

const SOURCE = 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn';
const DAY = 24 * 3600_000;

type Ranges = { start: bigint[]; end: bigint[] };
let v4: Ranges = { start: [], end: [] };
let v6: Ranges = { start: [], end: [] };
let loadedAt = 0;
export const vpnEnabled = () => process.env.VPN_BLOCK !== 'off';

function parseV4(ip: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

function parseV6(ip: string): bigint | null {
  if (!/^[0-9a-f:]+$/i.test(ip) || (ip.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, null];
  const hs = head ? head.split(':') : [];
  const ts = tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - hs.length - ts.length;
  if (fill < 0 || (tail === null && hs.length !== 8)) return null;
  const parts = [...hs, ...Array(fill).fill('0'), ...ts];
  let n = 0n;
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
    n = (n << 16n) | BigInt(parseInt(p, 16));
  }
  return n;
}

/** Turn a list of CIDRs into sorted, merged ranges for binary search. */
function build(text: string, v6list: boolean): Ranges {
  const bits = v6list ? 128n : 32n;
  const raw: [bigint, bigint][] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const [addr, lenS] = s.split('/');
    const base = v6list ? parseV6(addr) : parseV4(addr);
    const len = lenS === undefined ? bits : BigInt(lenS);
    if (base === null || len < 0n || len > bits) continue;
    const size = 1n << (bits - len);
    const start = (base / size) * size;
    raw.push([start, start + size - 1n]);
  }
  raw.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Ranges = { start: [], end: [] };
  for (const [s, e] of raw) {
    const last = out.end.length - 1;
    if (last >= 0 && s <= out.end[last] + 1n) { if (e > out.end[last]) out.end[last] = e; }
    else { out.start.push(s); out.end.push(e); }
  }
  return out;
}

function inRanges(r: Ranges, n: bigint): boolean {
  let lo = 0, hi = r.start.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (n < r.start[mid]) hi = mid - 1;
    else if (n > r.end[mid]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Is this address in a known VPN range? (IPv4, IPv6 and IPv4-mapped IPv6.) */
export function isVpnAddress(ip: string | undefined | null): boolean {
  if (!ip || !vpnEnabled()) return false;
  const a = ip.trim().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  const n4 = parseV4(mapped ? mapped[1] : a);
  if (n4 !== null) return inRanges(v4, n4);
  const n6 = parseV6(a.split('%')[0]);
  return n6 !== null && inRanges(v6, n6);
}

const IP_LIKE = /^[0-9a-f:.]{3,45}$/i;
let ipSourceLogged = 0;

/**
 * The visitor's real address. On Render every request passes through Cloudflare, which
 * always overwrites CF-Connecting-IP (and True-Client-IP) with the address it actually saw,
 * so a visitor can't fake them. X-Forwarded-For is NOT used: a visitor can put anything at
 * its front. Off Render (local development) Fastify's own value is used.
 */
export function realClientIp(headers: Record<string, string | string[] | undefined>, fallback: string): string {
  if (process.env.RENDER === 'true') {
    for (const k of ['cf-connecting-ip', 'true-client-ip']) {
      const v = headers[k];
      if (typeof v === 'string' && IP_LIKE.test(v.trim())) {
        if (ipSourceLogged < 2) { ipSourceLogged++; console.log(`client address source: ${k}`); }
        return v.trim();
      }
    }
    if (ipSourceLogged < 4) { ipSourceLogged = 4; console.warn('client address source: no Cloudflare header, using the proxy-reported address'); }
  }
  return fallback;
}

/** Whether the VPN guard applies to this account (new, or banned before; never the admin). */
export function vpnGuardApplies(a: { trust: number; createdAt: Date | string; everBanned: boolean }): boolean {
  if (a.trust >= Trust.Admin) return false;
  if (a.everBanned) return true;
  return Date.now() - new Date(a.createdAt).getTime() < SAFETY.vpnNewAccountDays * DAY;
}

export const VPN_SIGNUP_MESSAGE = "New accounts can't be created through a VPN or proxy. Please turn off your VPN (or iCloud Private Relay) and try again.";
export const VPN_ACCOUNT_MESSAGE = "This account can't be used through a VPN or proxy right now. Please turn off your VPN (or iCloud Private Relay) and try again.";

function install(t4: string, t6: string) {
  const n4 = build(t4, false), n6 = build(t6, true);
  if (n4.start.length < 100) throw new Error('VPN list looks empty');
  v4 = n4; v6 = n6; loadedAt = Date.now();
}

/** Load the bundled copy now, then try GitHub; call again (hourly) and it refreshes once a day. */
export async function refreshVpnList(log: (m: string) => void): Promise<void> {
  if (!loadedAt) {
    try {
      install(readFileSync('server/db/vpn/ipv4.txt', 'utf8'), readFileSync('server/db/vpn/ipv6.txt', 'utf8'));
      loadedAt = 1; // bundled copy: still try for a fresher one right away
      log(`VPN list: ${v4.start.length} IPv4 and ${v6.start.length} IPv6 ranges from the bundled copy`);
    } catch (e) { log(`VPN list: bundled copy unusable (${(e as Error).message})`); }
  }
  if (Date.now() - loadedAt < DAY) return;
  try {
    const get = async (f: string) => {
      const r = await fetch(`${SOURCE}/${f}`, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
      return r.text();
    };
    const [t4, t6] = await Promise.all([get('ipv4.txt'), get('ipv6.txt')]);
    install(t4, t6);
    log(`VPN list: refreshed, ${v4.start.length} IPv4 and ${v6.start.length} IPv6 ranges`);
  } catch (e) {
    log(`VPN list: refresh failed, keeping the current list (${(e as Error).message})`);
    if (loadedAt === 1) loadedAt = Date.now() - DAY + 3600_000; // try again in an hour
  }
}

/** Simple page for a blocked visit (no scripts). */
export function vpnPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Turn off your VPN · RoleplayRetro</title>
<style>body{font-family:system-ui,sans-serif;background:#fff7f7;color:#1b1b1f;margin:0;display:grid;place-items:center;min-height:100vh;padding:1rem}
main{max-width:30rem;border:3px solid #d20f24;border-radius:16px;background:#fff;padding:1.5rem}h1{margin-top:0;color:#d20f24;font-size:1.4rem}</style></head>
<body><main><h1>Please turn off your VPN</h1><p>${VPN_ACCOUNT_MESSAGE}</p><p>Then reload this page.</p></main></body></html>`;
}
