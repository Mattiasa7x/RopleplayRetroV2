/**
 * Gold Quill: RoleplayRetro's paid supporter tier. One-time passes bought through PayPal;
 * nothing renews by itself, and buying again adds time on top of what's left.
 */

export const QUILL_NAME = 'Gold Quill';

export type QuillPassId = 'day' | 'week' | 'month';

export interface QuillPass { id: QuillPassId; label: string; days: number; /** USD, as PayPal wants it. */ price: string }

export const QUILL_PASSES: QuillPass[] = [
  { id: 'day', label: 'Day pass', days: 1, price: '0.99' },
  { id: 'week', label: 'Week pass', days: 7, price: '3.99' },
  { id: 'month', label: 'Month pass', days: 30, price: '9.99' },
];

export const QUILL_PASS_BY_ID = new Map(QUILL_PASSES.map((p) => [p.id, p]));

/** What a pass unlocks (shown on the Gold Quill page). */
export const QUILL_PERKS: { icon: string; title: string; text: string }[] = [
  { icon: '👁️', title: 'Profile Views', text: 'See who visited your profile, and when.' },
  { icon: '🎁', title: 'Twice the gifts', text: 'Send 10 gifts a day instead of 5.' },
  { icon: '✨', title: '50 exclusive gifts', text: 'Five collections only Gold Quill members can send.' },
  { icon: '🖼️', title: 'Exclusive themes', text: 'Members-only backgrounds for your profile and your rooms.' },
  { icon: '🪶', title: 'The gold ring', text: 'A gold frame around your picture everywhere on the site. Hide it any time in Privacy.' },
];

export const QUILL_GIFTS_PER_DAY = 10;

/** Is a Gold Quill pass active right now? */
export const quillActive = (until: string | Date | null | undefined, now = Date.now()) =>
  !!until && new Date(until).getTime() > now;
