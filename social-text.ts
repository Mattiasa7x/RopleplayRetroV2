import { SAFETY, Trust } from '../../shared/config.js';
import { checkBody } from '../../shared/text.js';
import { redis } from '../store.js';
import { containsLink, floodKey } from './filter.js';
import { notRepeated, slidingWindow } from './limits.js';
import { activeSanctions, textBlocked } from './pipeline.js';

export type SocialVerdict = { ok: true; body: string; shadow: boolean } | { ok: false; error: string; message: string };

const LIMITS: Record<string, { max: number; windowMs: number; label: string }> = {
  comment: { max: 5, windowMs: 60_000, label: '5 comments a minute' },
  status: { max: 10, windowMs: 3600_000, label: '10 status updates an hour' },
};

/**
 * Checks for profile comments and status updates: the same rules as chat
 * (420 characters, blocklist, links only for Established members, repeats, site-wide
 * mutes and bans), with their own rate limits. Shadow-muted members can post, but only they see it.
 */
export async function checkSocialText(user: { id: string; trust: number }, raw: string, kind: 'comment' | 'status'): Promise<SocialVerdict> {
  const shape = checkBody(raw);
  if (!shape.ok) return { ok: false, error: shape.code, message: shape.message };
  if (user.trust < Trust.Verified) return { ok: false, error: 'verify', message: 'Confirm your email to post.' };

  const s = await activeSanctions(user.id, null);
  if (s.some((x) => x.room_id === null && (x.kind === 'ban' || x.kind === 'mute'))) {
    return { ok: false, error: 'sanctioned', message: "You can't post while muted or banned." };
  }
  const lim = LIMITS[kind];
  if (!(await slidingWindow(redis, `rl:${kind}:${user.id}`, lim.max, lim.windowMs))) {
    return { ok: false, error: 'rate', message: `Slow down: at most ${lim.label}.` };
  }
  if (!(await notRepeated(redis, user.id, floodKey(shape.body), SAFETY.floodWindowMs))) {
    return { ok: false, error: 'repeat', message: 'You just posted that.' };
  }
  if (textBlocked(shape.body)) return { ok: false, error: 'blocked_word', message: "That contains a word that isn't allowed here." };
  if (user.trust < Trust.Established && containsLink(shape.body)) {
    return { ok: false, error: 'link', message: 'Links unlock once your account is established (7 days and 100 messages).' };
  }
  return { ok: true, body: shape.body, shadow: s.some((x) => x.kind === 'shadow_mute') };
}
