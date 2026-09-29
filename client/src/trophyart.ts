import { TROPHY_BY_ID, type TrophyGroup } from '../../shared/trophies.js';
import { h } from './dom.js';

/**
 * Badge artwork, drawn in SVG so it stays sharp at any size. Each group has its own frame
 * (time: rosette medal, security: shield, chat: hexagon) and each trophy its own colour and
 * emblem. Emblems are white; `D` marks details drawn in the badge's dark shade.
 */

const COLOR: Record<string, string> = {
  noob: '#7cc95a', wanderer: '#22a99a', regular: '#e08a2a', veteran: '#4a78d6', old_guard: '#8656d4',
  warded: '#d0344a',
  chatterbox: '#f0569a', wordsmith: '#c07a3a', storyteller: '#8fa5bd', loremaster: '#e8b32e',
};

const W = 'fill="#fff" stroke="none"';
const S = 'fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';
const D = (dark: string, extra = '') => `fill="none" stroke="${dark}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}`;

const EMBLEM: Record<string, (dark: string) => string> = {
  // a freshly cracked egg
  noob: (d) => `<path d="M32 17c-6.5 0-11.5 9.5-11.5 17.5a11.5 11.5 0 0 0 23 0C43.5 26.5 38.5 17 32 17z" ${W}/>
    <path d="M22.5 33l4.5 2.6 3.6-3.8 3.4 3.8 4.2-3 3.2 1.8" ${D(d)}/>`,
  // a compass
  wanderer: (d) => `<circle cx="32" cy="33" r="12.5" ${S}/>
    <path d="M32 22.5l3.6 10.5H28.4z" ${W}/><path d="M28.4 33h7.2L32 43.5z" fill="#fff" fill-opacity=".45"/>
    <circle cx="32" cy="33" r="1.6" fill="${d}"/>`,
  // a foaming tankard
  regular: (d) => `<rect x="22" y="25" width="15.5" height="18" rx="2.2" ${W}/>
    <path d="M37.5 28.5h2.6a3.7 3.7 0 0 1 0 7.4h-2.6" ${S}/>
    <path d="M20.5 26c-.6-3.6 2.8-5.2 5.2-3.8 1-2.4 5.5-2.6 6.6-.2 2.4-1.5 6.4-.3 5.9 4z" ${W}/>
    <path d="M26.5 30v9M33 30v9" ${D(d)}/>`,
  // three rank chevrons
  veteran: () => `<path d="M21 24l11 6.5L43 24M21 31.5l11 6.5 11-6.5M21 39l11 6.5L43 39" ${S} stroke-width="3.2"/>`,
  // a castle tower
  old_guard: (d) => `<path d="M22.5 45V27h3.4v-4.2h3.2V27h5.8v-4.2h3.2V27h3.4v18z" ${W}/>
    <path d="M29 45v-5.5a3 3 0 0 1 6 0V45" fill="${d}" stroke="none"/><path d="M27.5 32.5h2M34.5 32.5h2" ${D(d)}/>`,
  // a padlock
  warded: (d) => `<path d="M26 30v-4.5a6 6 0 0 1 12 0V30" ${S} stroke-width="3"/>
    <rect x="22.5" y="29.5" width="19" height="15" rx="2.6" ${W}/>
    <circle cx="32" cy="35.5" r="2.2" fill="${d}"/><path d="M32 37v3.6" ${D(d)} stroke-width="2.4"/>`,
  // a speech bubble
  chatterbox: (d) => `<path d="M21.5 22.5h21a3.5 3.5 0 0 1 3.5 3.5v11a3.5 3.5 0 0 1-3.5 3.5H31l-6.5 5.5v-5.5h-3a3.5 3.5 0 0 1-3.5-3.5V26a3.5 3.5 0 0 1 3.5-3.5z" ${W}/>
    <circle cx="25.5" cy="31.5" r="1.8" fill="${d}"/><circle cx="32" cy="31.5" r="1.8" fill="${d}"/><circle cx="38.5" cy="31.5" r="1.8" fill="${d}"/>`,
  // a quill
  wordsmith: (d) => `<path d="M44.5 18.5c-10.5 1.5-18.5 9.5-20.5 21l-1.3 4.8 4.8-1.3c11.5-2 19-10.5 17-24.5z" ${W}/>
    <path d="M22 46.5l15-16.5M31 35.5h5.5M34.5 30h5" ${D(d)}/>`,
  // an open book
  storyteller: (d) => `<path d="M32 25c-4.2-3-9.5-3.4-13.5-2.2v19c4-1.2 9.3-.8 13.5 2.2 4.2-3 9.5-3.4 13.5-2.2v-19C41.5 21.6 36.2 22 32 25z" ${W}/>
    <path d="M32 25v19M22 28c2.4-.6 5-.4 7 .6M22 32.5c2.4-.6 5-.4 7 .6M35 28.6c2-1 4.6-1.2 7-.6M35 33.1c2-1 4.6-1.2 7-.6" ${D(d)} stroke-width="1.6"/>`,
  // a jewelled crown
  loremaster: (d) => `<path d="M19.5 41l-2-15.5 8 6.5 6.5-10.5 6.5 10.5 8-6.5-2 15.5z" ${W}/>
    <rect x="19.5" y="42.5" width="25" height="4" rx="1.5" ${W}/>
    <circle cx="32" cy="35" r="2.3" fill="${d}"/><circle cx="25" cy="37" r="1.5" fill="${d}"/><circle cx="39" cy="37" r="1.5" fill="${d}"/>`,
};

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(f);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function rosette(): string {
  const pts: string[] = [];
  for (let i = 0; i < 32; i++) {
    const r = i % 2 ? 26.5 : 30, a = (Math.PI * 2 * i) / 32 - Math.PI / 2;
    pts.push(`${(32 + r * Math.cos(a)).toFixed(2)},${(32 + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}
const ROSETTE = rosette();

function frame(group: TrophyGroup, fill: string, edge: string, dark: string): string {
  if (group === 'security') {
    return `<path d="M32 3.5l24 8.5v17.5c0 15.5-10.5 26-24 31-13.5-5-24-15.5-24-31V12z" fill="${dark}"/>
      <path d="M32 7.5l20 7v15c0 13-8.8 22-20 26.5-11.2-4.5-20-13.5-20-26.5v-15z" fill="${fill}" stroke="${edge}" stroke-width="1.2"/>`;
  }
  if (group === 'chat') {
    return `<path d="M32 3l25 14.5v29L32 61 7 46.5v-29z" fill="${dark}"/>
      <path d="M32 7.5l21 12.2v24.6L32 56.5 11 44.3V19.7z" fill="${fill}" stroke="${edge}" stroke-width="1.2"/>`;
  }
  return `<polygon points="${ROSETTE}" fill="${dark}"/>
    <circle cx="32" cy="32" r="23.5" fill="${fill}" stroke="${edge}" stroke-width="1.2"/>
    <circle cx="32" cy="32" r="20" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="1"/>`;
}

let uid = 0;

/** One badge. Locked badges show greyed out. */
export function trophyBadge(id: string, opts: { size?: number; locked?: boolean } = {}): HTMLElement {
  const t = TROPHY_BY_ID.get(id);
  const base = COLOR[id] ?? '#888888';
  const dark = shade(base, -0.45);
  const g = `tg${++uid}`;
  const svg = `<svg viewBox="0 0 64 64" width="${opts.size ?? 56}" height="${opts.size ?? 56}" focusable="false" aria-hidden="true">
    <defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${shade(base, 0.35)}"/><stop offset=".55" stop-color="${base}"/><stop offset="1" stop-color="${shade(base, -0.25)}"/>
    </linearGradient></defs>
    ${frame(t?.group ?? 'time', `url(#${g})`, shade(base, 0.55), dark)}
    ${(EMBLEM[id] ?? (() => ''))(dark)}
  </svg>`;
  const el = h('span', { class: `trophy-badge${opts.locked ? ' locked' : ''}` });
  el.innerHTML = svg; // built only from the fixed strings above
  return el;
}
