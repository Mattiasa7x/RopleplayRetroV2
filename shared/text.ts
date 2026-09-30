import { CHAT } from './config.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Count user-visible characters, so "👍🏽" or "é" each count as one. */
export function visibleLength(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/**
 * Normalise a message body the same way on client and server:
 * Unicode NFC, line breaks and tabs to spaces, runs of spaces collapsed,
 * invisible control/format characters removed, then trimmed.
 */
export function cleanBody(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    // strip C0/C1 controls and zero-width / bidi-override characters used to hide text.
    // U+200D (zero-width joiner) is kept: emoji sequences like 👨‍👩‍👧 need it.
    .replace(/[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export type BodyCheck =
  | { ok: true; body: string; length: number }
  | { ok: false; code: 'empty' | 'too_long'; message: string; length: number };

export function checkBody(raw: string): BodyCheck {
  const body = cleanBody(raw);
  const length = visibleLength(body);
  if (length === 0) return { ok: false, code: 'empty', message: 'Type something first.', length };
  if (length > CHAT.MAX_CHARS) {
    return {
      ok: false,
      code: 'too_long',
      message: `Messages are limited to ${CHAT.MAX_CHARS} characters (yours is ${length}).`,
      length,
    };
  }
  return { ok: true, body, length };
}

const MENTION_RE = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]{3,16})(?![A-Za-z0-9_-])/g;

/** Unique @handles in the order they appear (lower-cased). */
export function extractMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) seen.add(m[2].toLowerCase());
  return [...seen];
}
