import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAT, SAFETY, SITE_ROOMS, Trust } from '../../shared/config.js';
import { checkBody, extractMentions } from '../../shared/text.js';
import { db, redis } from '../store.js';
import { containsBlocked, containsLink, floodKey, isShouting, parseBlocklist, type BlockEntry } from './filter.js';
import { notRepeated, slidingWindow, slowMode } from './limits.js';
import { STRIKE_CODES, recordStrike } from './strikes.js';
import { containsMature } from './mature.js';

const BLOCKLIST_PATH = resolve(process.env.BLOCKLIST_PATH ?? 'server/safety/blocklist.txt');
let blocklist: BlockEntry[] = parseBlocklist(readFileSync(BLOCKLIST_PATH, 'utf8'));

/** True if text contains a blocked word (also used for room names and descriptions). */
export function textBlocked(text: string): boolean {
  return containsBlocked(text, blocklist);
}

/** Re-read the blocklist file without a restart (admin endpoint). */
export function reloadBlocklist(): number {
  blocklist = parseBlocklist(readFileSync(BLOCKLIST_PATH, 'utf8'));
  return blocklist.length;
}

export interface Sanction {
  id: string;
  kind: 'mute' | 'kick' | 'ban' | 'shadow_mute';
  room_id: number | null;
  reason: string;
  expires_at: Date | null;
}

/** Active sanctions that apply in this room (room-scoped ones for this room, plus site-wide). */
export async function activeSanctions(userId: string, roomId: number | null): Promise<Sanction[]> {
  const { rows } = await db.query<Sanction>(
    `SELECT id, kind, room_id, reason, expires_at FROM sanctions
      WHERE user_id = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND (room_id IS NULL OR room_id = $2)`,
    [userId, roomId],
  );
  return rows;
}

function until(d: Date | null): string {
  if (!d) return 'until a moderator lifts it';
  const mins = Math.max(1, Math.ceil((d.getTime() - Date.now()) / 60000));
  return mins < 90 ? `for ${mins} more minute${mins === 1 ? '' : 's'}` : `until ${d.toUTCString()}`;
}

/** Can this user be in the room at all? (Used for joining and reading history.) */
export function accessBlock(s: Sanction[]): string | null {
  const ban = s.find((x) => x.kind === 'ban');
  if (ban) return ban.room_id ? `You are banned from this room ${until(ban.expires_at)}.` : `Your account is banned ${until(ban.expires_at)}.`;
  const kick = s.find((x) => x.kind === 'kick');
  if (kick) return `You were removed from this room. You can come back ${until(kick.expires_at)}.`;
  return null;
}

export interface SendContext {
  user: { id: string; trust: number; createdAt: Date };
  room: { id: number; kind: 'site' | 'member'; min_trust_to_post: number; slow_mode_seconds: number; chat_filter?: boolean };
  raw: string;
}

export type Verdict =
  | { ok: true; body: string; mentionHandles: string[]; shadow: boolean }
  | { ok: false; error: string; message: string };

const no = (error: string, message: string): Verdict => ({ ok: false, error, message });

/**
 * Every message goes through here, in this order:
 *   0. shape (length, blank)   1. sanctions   2. trust   3. rate limits   4. flood   5. content
 * Messages from shadow-muted users pass through normally but are marked `shadow`,
 * so the sender sees them and nobody else does.
 *
 * Site rooms run in strict mode: links blocked for everyone below staff, fewer mentions,
 * slow mode for accounts under a day old, and every rule-breaking rejection is a strike
 * that can trigger an automatic mute (server/safety/strikes.ts).
 */
export async function checkMessage(ctx: SendContext): Promise<Verdict> {
  const verdict = await runChecks(ctx);
  if (!verdict.ok && ctx.room.kind === 'site' && STRIKE_CODES.has(verdict.error)) {
    const extra = await recordStrike(ctx.user.id, ctx.room.id, verdict.error);
    if (extra) return { ...verdict, message: `${verdict.message} ${extra}` };
  }
  return verdict;
}

async function runChecks(ctx: SendContext): Promise<Verdict> {
  const { user, room } = ctx;
  const strict = room.kind === 'site';
  const staff = user.trust >= Trust.RoomModerator;

  const shape = checkBody(ctx.raw);
  if (!shape.ok) return no(shape.code, shape.message);
  const body = shape.body;

  // 1. Sanctions
  const s = await activeSanctions(user.id, room.id);
  const blocked = accessBlock(s);
  if (blocked) return no('sanctioned', blocked);
  const mute = s.find((x) => x.kind === 'mute');
  if (mute) return no('muted', `You are muted ${until(mute.expires_at)}. Reason: ${mute.reason}`);
  const shadow = s.some((x) => x.kind === 'shadow_mute');

  // 2. Trust
  if (user.trust < room.min_trust_to_post) {
    return no(
      'trust',
      user.trust === Trust.New
        ? 'Confirm your email to chat here. Until then you can chat in Newcomers and Help Desk.'
        : 'This room is open to established members only.',
    );
  }

  // 3. Rate limits (counted on every attempt)
  const max = SAFETY.rateLimit.maxByTrust[user.trust] ?? 3;
  if (!(await slidingWindow(redis, `rl:msg:${user.id}`, max, SAFETY.rateLimit.windowMs))) {
    return no('rate', `Slow down: at most ${max} messages every ${SAFETY.rateLimit.windowMs / 1000} seconds.`);
  }
  const young = Date.now() - user.createdAt.getTime() < SITE_ROOMS.newAccountHours * 3600_000;
  const slowSeconds = strict && young && !staff ? Math.max(room.slow_mode_seconds, SITE_ROOMS.newAccountSlowSeconds) : room.slow_mode_seconds;
  if (!(await slowMode(redis, room.id, user.id, slowSeconds))) {
    return no(
      'slow_mode',
      slowSeconds > room.slow_mode_seconds
        ? `New accounts can post once every ${slowSeconds} seconds in site rooms for their first day.`
        : `Slow mode is on: one message every ${slowSeconds} seconds in this room.`,
    );
  }

  // 4. Flood
  if (!(await notRepeated(redis, user.id, floodKey(body), SAFETY.floodWindowMs))) {
    return no('repeat', 'You just said that. Try something new.');
  }
  if (isShouting(body, SAFETY.capsMinLetters, SAFETY.capsRatio)) {
    return no('caps', 'Easy on the caps lock, please.');
  }

  // 5. Content
  if (containsBlocked(body, blocklist)) return no('blocked_word', "That message contains a word that isn't allowed here.");
  if ((room.kind === 'site' || room.chat_filter) && containsMature(body)) {
    return no('room_filter', "This room's chat filter is on, so swear words can't be sent here.");
  }
  if (containsLink(body)) {
    if (strict && SITE_ROOMS.blockLinksForAll && !staff) return no('link', "Links aren't allowed in site rooms. Share them in a member room.");
    if (user.trust < Trust.Established) return no('link', 'Links unlock once your account is established (7 days and 100 messages).');
  }
  const mentionHandles = extractMentions(body);
  const maxMentions = strict ? SITE_ROOMS.maxMentions : CHAT.MAX_MENTIONS;
  if (mentionHandles.length > maxMentions) {
    return no('mentions', `You can mention at most ${maxMentions} people in one message${strict ? ' in site rooms' : ''}.`);
  }

  return { ok: true, body, mentionHandles, shadow };
}
