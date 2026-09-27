import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeForFilter, parseBlocklist, type BlockEntry } from './filter.js';

/**
 * The personal chat filter. Unlike the blocklist (slurs and worse, refused for everyone),
 * mature words are allowed to be sent but are masked for anyone whose filter is on.
 * Members under 18 always have it on.
 */

const PATH = resolve(process.env.MATURE_WORDS_PATH ?? 'server/safety/mature-words.txt');
let list: BlockEntry[] = parseBlocklist(readFileSync(PATH, 'utf8'));

export function reloadMatureWords(): number {
  list = parseBlocklist(readFileSync(PATH, 'utf8'));
  return list.length;
}

/** Pure masking against a given list (tested). Keeps the text's shape: "what the heck" → "what the h***". */
export function maskWith(text: string, entries: BlockEntry[]): string {
  if (!entries.length) return text;
  return text.replace(/[\p{L}\p{N}@$!|_]*[\p{L}\p{N}]/gu, (word) => { // a word ends in a letter or digit, so "heck!" keeps its "!"
    const n = normalizeForFilter(word).replace(/[^\p{L}]/gu, '');
    const hit = entries.some((e) => n === e.word || (e.prefix && n.startsWith(e.word)));
    return hit ? word[0] + '*'.repeat(Math.max(1, [...word].length - 1)) : word;
  });
}

export function maskMature(text: string): string {
  return maskWith(text, list);
}
