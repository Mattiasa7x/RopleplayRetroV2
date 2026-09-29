import { TROPHIES, TROPHY_GROUPS, type TrophyDef } from '../../../shared/trophies.js';
import type { TrophyPageDTO } from '../../../shared/types.js';
import { card, page } from '../core.js';
import { api, h } from '../dom.js';
import { trophyBadge } from '../trophyart.js';

const num = (n: number) => Math.floor(n).toLocaleString();

/** "in 40 minutes", "in 5 hours", "in 3 days". */
function timeLeft(hours: number): string {
  if (hours < 1) { const m = Math.max(1, Math.ceil(hours * 60)); return `in ${m} minute${m === 1 ? '' : 's'}`; }
  if (hours < 48) { const x = Math.ceil(hours); return `in ${x} hour${x === 1 ? '' : 's'}`; }
  const days = Math.ceil(hours / 24);
  if (days < 60) return `in ${days} days`;
  if (days < 730) return `in about ${Math.round(days / 30.4)} months`;
  return `in about ${Math.round(days / 365)} years`;
}

function bar(value: number, goal: number, label: string): HTMLElement {
  const pct = Math.max(0, Math.min(100, (value / goal) * 100));
  const fill = h('span', {});
  fill.style.width = `${pct.toFixed(1)}%`;
  return h('div', { class: 'trophy-progress' },
    h('div', { class: 'trophy-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(goal), 'aria-valuenow': String(Math.floor(Math.min(value, goal))), 'aria-label': label },
      fill),
    h('span', { class: 'muted small' }, label));
}

function progressFor(t: TrophyDef, p: NonNullable<TrophyPageDTO['progress']>): HTMLElement | null {
  if (t.group === 'time') return bar(p.accountHours, t.goal!, `Earned ${timeLeft(t.goal! - p.accountHours)}`);
  if (t.group === 'chat') return bar(p.messages, t.goal!, `${num(Math.min(p.messages, t.goal!))} / ${num(t.goal!)} messages`);
  if (t.group === 'social') return bar(p.friends, t.goal!, `${num(Math.min(p.friends, t.goal!))} / ${num(t.goal!)} friends`);
  const s = p.security;
  const step = (done: boolean, text: string, href: string) =>
    h('li', { class: done ? 'done' : '' }, h('span', { 'aria-hidden': 'true' }, done ? '✓' : '○'), ' ',
      done ? text : h('a', { href }, text), h('span', { class: 'visually-hidden' }, done ? ' (done)' : ' (to do)'));
  return h('ul', { class: 'trophy-steps' },
    step(s.email, 'Confirm your email', '/verify'),
    step(s.phone, 'Add a phone number', '/edit-profile?tab=account'),
    step(s.twoFactor, 'Turn on two-factor sign-in', '/settings?tab=security'));
}

/** A member's trophy case: yours shows every trophy and how close you are; others show what they've earned. */
export async function viewTrophies(handle: string) {
  page('Trophies', h('p', { class: 'muted' }, 'Loading…'));
  const d = await api<TrophyPageDTO>(`/api/trophies/${encodeURIComponent(handle)}`);
  const earned = new Map(d.earned.map((e) => [e.id, e.earnedAt]));
  const back = h('a', { href: `/profile/${d.handle}`, class: 'back' }, `‹ ${d.handle}`);
  if (!d.visible) {
    page('Trophies', back, card(null, h('p', { class: 'muted' }, `${d.handle} shares their profile with friends only.`)));
    return;
  }
  const summary = h('p', { class: 'trophy-count' }, `${earned.size} of ${TROPHIES.length} trophies earned`);

  const groups = TROPHY_GROUPS.map((g) => {
    const list = TROPHIES.filter((t) => t.group === g.id && (d.self || earned.has(t.id)));
    if (!list.length) return null;
    return card(g.title, h('ul', { class: 'trophy-list' }, ...list.map((t) => {
      const when = earned.get(t.id);
      return h('li', { class: `trophy-item${when ? ' earned' : ''}` },
        trophyBadge(t.id, { size: 64, locked: !when }),
        h('div', { class: 'trophy-text' },
          h('strong', {}, t.name),
          h('span', { class: 'small' }, t.how),
          when ? h('span', { class: 'muted small' }, `Earned ${new Date(when).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`)
            : d.progress ? progressFor(t, d.progress) : null));
    })));
  });
  page('Trophies', back, summary,
    ...(earned.size || d.self ? groups : [card(null, h('p', { class: 'muted' }, `${d.handle} hasn't earned any trophies yet.`))]));
}
