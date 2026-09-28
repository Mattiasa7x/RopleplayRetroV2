/**
 * Content filter: pure functions, no I/O, so it is easy to unit-test.
 *
 * The blocklist lives in blocklist.txt (one entry per line, `#` comments,
 * trailing `*` = also match words that start with it). Matching runs on a
 * normalised form of the message that defeats common dodges:
 *   accents and look-alike letters  (Cyrillic "а", "é")  → plain letters
 *   number/symbol swaps             (h3ll0, $, @)          → letters
 *   stretched letters               (baaaad)               → single letters
 *   spaced or dotted letters        (b a d, b.a.d)         → joined
 */

const LOOKALIKES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
  // Greek
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  // symbols and digits
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '€': 'e',
};

/** Lower-case, strip accents, map look-alikes, collapse repeated letters. */
export function normalizeForFilter(text: string): string {
  const base = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    // "!" and "|" stand in for letters only inside a word (b!tch), not as punctuation (hi!)
    .replace(/(?<=\p{L})!(?=\p{L})/gu, 'i')
    .replace(/(?<=\p{L})\|(?=\p{L})/gu, 'l');
  let out = '';
  for (const ch of base) out += LOOKALIKES[ch] ?? ch;
  return out.replace(/(\p{L})\1+/gu, '$1');
}

function tokenize(normalized: string): string[] {
  return normalized.split(/[^\p{L}]+/u).filter(Boolean);
}

/** Join runs of 2+ single-letter tokens: "b a d" → "bad". */
function joinedRuns(tokens: string[]): string[] {
  const runs: string[] = [];
  let cur = '';
  for (const t of tokens) {
    if (t.length === 1) cur += t;
    else {
      if (cur.length >= 2) runs.push(cur);
      cur = '';
    }
  }
  if (cur.length >= 2) runs.push(cur);
  // Spaced-out letters can hide doubled letters ("g g"): collapse them like the rest of the text.
  return runs.map((r) => r.replace(/(\p{L})\1+/gu, '$1'));
}

export interface BlockEntry {
  word: string; // normalised; for a phrase, its words joined by single spaces
  prefix: boolean;
  /** A multi-word entry ("send me pics"): matched as whole consecutive words. */
  phrase?: boolean;
}

/** Words of a text for phrase matching: apostrophes dropped first, so "don't" and "dont" match alike. */
function phraseWords(text: string): string[] {
  return tokenize(normalizeForFilter(text.replace(/['\u2019`]/g, '')));
}

export function parseBlocklist(fileText: string): BlockEntry[] {
  return fileText
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l): BlockEntry => {
      const prefix = l.endsWith('*');
      const raw = prefix ? l.slice(0, -1) : l;
      const words = phraseWords(raw);
      if (words.length > 1) return { word: words.join(' '), prefix: false, phrase: true };
      return { word: normalizeForFilter(raw), prefix };
    })
    .filter((e) => e.word.length > 0);
}

export function containsBlocked(text: string, list: BlockEntry[]): boolean {
  if (!list.length) return false;
  const tokens = tokenize(normalizeForFilter(text));
  const runs = joinedRuns(tokens);
  const spaced = list.some((e) => e.phrase) ? ` ${phraseWords(text).join(' ')} ` : '';
  for (const e of list) {
    if (e.phrase) {
      if (spaced.includes(` ${e.word} `)) return true;
      continue;
    }
    for (const t of tokens) {
      if (t === e.word || (e.prefix && t.startsWith(e.word))) return true;
    }
    for (const r of runs) if (r.includes(e.word)) return true;
  }
  return false;
}

const LINK_RE =
  /(https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\s*(\.|\(dot\)|\[dot\])\s*(com|net|org|io|gg|ly|co|me|tv|xyz|info|biz|app|link|ru|cn)\b/i;

export function containsLink(text: string): boolean {
  return LINK_RE.test(text);
}

export function isShouting(text: string, minLetters: number, ratio: number): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < minLetters) return false;
  const upper = text.match(/\p{Lu}/gu) ?? [];
  return upper.length / letters.length >= ratio;
}

/** Key used by the flood check: two messages that differ only in spacing, punctuation or case collide. */
export function floodKey(text: string): string {
  return normalizeForFilter(text).replace(/[^\p{L}\p{N}]+/gu, '');
}
