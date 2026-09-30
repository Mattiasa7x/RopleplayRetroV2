import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleSkeleton, isReservedHandle } from '../../shared/handles.js';

/**
 * Is this username acceptable? Reserved/staff names (shared/handles.ts, in any disguise)
 * plus the chat blocklist, the swear-word list and a username-only list, searched for
 * inside the name. Three views of a name are compared, each against the word lists turned
 * into the same view:
 *   mid       lower case, no underscores or hyphens, number swaps on older names (0→o, 1→l…)
 *   skeleton  mid plus stretched letters collapsed and rn→m, vv→w (catches Fuuuck, sh1iit)
 *   parts     the name split at underscores and CapitalLetters, each in the mid view (for
 *             short words, which would otherwise hide inside innocent names)
 * Innocent words that contain a blocked word (handle-allow.txt) are removed first.
 */

const DIGITS: Record<string, string> = { '0': 'o', '1': 'l', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'b', '7': 't', '8': 'b', '9': 'g' };
const mid = (s: string) => s.toLowerCase().replace(/[_-]/g, '').replace(/[0-9]/g, (d) => DIGITS[d]);

function words(file: string): string[] {
  const out: string[] = [];
  for (const line of readFileSync(resolve(file), 'utf8').split('\n')) {
    const w = line.trim().toLowerCase();
    if (!w || w.startsWith('#') || /\s/.test(w)) continue; // phrases can't be usernames
    out.push(w.replace(/\*$/, '').replace(/['’-]/g, ''));
  }
  return out;
}

let lists: { long: { mid: string; skel: string }[]; short: Set<string>; allowMid: string[]; allowSkel: string[] } | null = null;
function load() {
  if (lists) return lists;
  const all = [...new Set([
    ...words(process.env.BLOCKLIST_PATH ?? 'server/safety/blocklist.txt'),
    ...words(process.env.MATURE_WORDS_PATH ?? 'server/safety/mature-words.txt'),
    ...words('server/safety/handle-words.txt'),
  ])].filter((w) => /^[a-z0-9]+$/.test(w));
  const allow = words('server/safety/handle-allow.txt');
  const long: { mid: string; skel: string }[] = [];
  const short = new Set<string>();
  for (const w of all) {
    const m = mid(w);
    if (m.length <= 3) short.add(m);
    else long.push({ mid: m, skel: handleSkeleton(w) });
  }
  lists = { long, short, allowMid: allow.map(mid), allowSkel: allow.map(handleSkeleton) };
  return lists;
}

const strip = (s: string, allowed: string[]) => allowed.reduce((acc, a) => acc.split(a).join('_'), s);

export type HandleProblem = 'reserved' | 'offensive' | null;

export function handleProblem(handle: string): HandleProblem {
  if (isReservedHandle(handle)) return 'reserved';
  const L = load();
  const m = strip(mid(handle), L.allowMid);
  const sk = strip(handleSkeleton(handle), L.allowSkel);
  for (const w of L.long) {
    if (m.includes(w.mid)) return 'offensive';
    if (w.skel.length >= 4 && sk.includes(w.skel)) return 'offensive';
  }
  const parts = handle.split(/[_-]|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).map(mid);
  if (parts.some((p) => L.short.has(p)) || L.short.has(mid(handle))) return 'offensive';
  return null;
}

export const HANDLE_PROBLEM_MESSAGE: Record<Exclude<HandleProblem, null>, string> = {
  reserved: 'That name is reserved. Please pick another.',
  offensive: "That name isn't allowed. Please pick another.",
};
