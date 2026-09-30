import { TROPHY_BY_ID, type TrophyGroup } from '../../shared/trophies.js';
import { h } from './dom.js';

/**
 * Badge artwork, drawn in SVG so it stays sharp at any size. Each group has its own frame
 * (time: rosette medal, account: shield, chat: hexagon, or a heart for chat likes, friends: diamond, private messages: postage stamp, photos: instant photo) and each trophy its own colour and
 * emblem. Emblems are white; `D` marks details drawn in the badge's dark shade.
 */

const COLOR: Record<string, string> = {
  noob: '#7cc95a', wanderer: '#22a99a', regular: '#e08a2a', veteran: '#4a78d6', old_guard: '#8656d4',
  warded: '#d0344a',
  chatterbox: '#f0569a', wordsmith: '#c07a3a', storyteller: '#8fa5bd', loremaster: '#e8b32e',
  good_company: '#3ea6e0', circle: '#27b07a', butterfly: '#c95ad8', heart: '#ef4f6c', luminary: '#f2a41f',
  fully_realized: '#1f9d8b', diarist: '#c2566f', chronicler: '#b0852a', keeper_of_days: '#2c4f9e', party_leader: '#e2873a',
  shutterbug: '#e0574a', scrapbooker: '#e3a624', curator: '#3c8f68', master_of_light: '#3a5bd6', guild_master: '#2f7fbf', sovereign: '#7a3fb5',
  courier: '#4e9fe0', herald: '#c9412f', emissary: '#7a5fd0', ravens: '#a9b6c8',
  lamplighter: '#e3a33a', night_watch: '#3f5fa8', hearthkeeper: '#d9622b', eternal_flame: '#b3321f',
  crowd_pleaser: '#f0567a', beloved_bard: '#c8437e', toast_of_tavern: '#c9432f', living_legend: '#e6a623',
};

/** Six little heads in a ring. */
function ring(d: string): string {
  let out = `<circle cx="32" cy="32" r="9.5" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.6"/>`;
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6 - Math.PI / 2;
    out += `<circle cx="${(32 + 9.5 * Math.cos(a)).toFixed(2)}" cy="${(32 + 9.5 * Math.sin(a)).toFixed(2)}" r="3.4" fill="#fff" stroke="${d}" stroke-width="1"/>`;
  }
  return out + `<path d="M32 28.2l1.1 2.4 2.6.3-1.9 1.8.5 2.6-2.3-1.3-2.3 1.3.5-2.6-1.9-1.8 2.6-.3z" fill="#fff"/>`;
}

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
  // a completed character sheet
  fully_realized: (d) => `<rect x="22" y="19.5" width="20" height="26" rx="2.2" ${W}/>
    <rect x="27.5" y="17" width="9" height="5" rx="1.5" fill="${d}"/>
    <circle cx="29.5" cy="27.5" r="3" fill="${d}" fill-opacity=".55"/>
    <path d="M34.5 26.5h4.5M34.5 29.5h3M25.5 34.5h13M25.5 38h9" ${D(d)} stroke-width="1.5" stroke-opacity=".7"/>
    <circle cx="41.5" cy="42.5" r="5.8" fill="${d}" stroke="#fff" stroke-width="1.6"/>
    <path d="M38.8 42.6l1.9 1.9 3.6-3.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  // a camera
  shutterbug: (d) => `<path d="M26.5 25l2.2-3.5h6.6l2.2 3.5z" ${W}/>
    <rect x="18.5" y="24.5" width="27" height="18" rx="3" ${W}/>
    <circle cx="32" cy="33.5" r="6.2" fill="${d}"/><circle cx="32" cy="33.5" r="3.4" fill="#fff" fill-opacity=".35"/>
    <circle cx="30.6" cy="32.1" r="1.1" fill="#fff"/><rect x="39.5" y="27" width="3.5" height="2.2" rx=".8" fill="${d}"/>`,
  // a stack of snapshots
  scrapbooker: (d) => `<rect x="19" y="21" width="21" height="18" rx="1.5" transform="rotate(-10 29.5 30)" fill="#fff" fill-opacity=".55"/>
    <rect x="24" y="26" width="21" height="18" rx="1.5" transform="rotate(7 34.5 35)" ${W}/>
    <g transform="rotate(7 34.5 35)"><path d="M26.5 41l5.2-6 3.6 3.8 2.6-2.6 4.6 4.8z" fill="${d}"/><circle cx="40" cy="30.5" r="1.9" fill="${d}"/></g>`,
  // a framed picture on an easel
  curator: (d) => `<path d="M25 47l5-9M39 47l-5-9M32 44v4" ${S} stroke-width="2.2"/>
    <rect x="20" y="18.5" width="24" height="20" rx="1.5" ${W}/>
    <rect x="23.5" y="22" width="17" height="13" fill="${d}" fill-opacity=".25"/>
    <path d="M24 34.5l5.5-6.5 4 4.5 2.8-2.8 4.2 4.8z" fill="${d}"/><circle cx="37" cy="25.5" r="1.8" fill="${d}"/>`,
  // a camera aperture
  master_of_light: (d) => {
    let blades = '';
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i, r = 11.5, ri = 4.5;
      const x1 = 32 + ri * Math.cos(a), y1 = 32.5 + ri * Math.sin(a);
      const x2 = 32 + r * Math.cos(a + 0.9), y2 = 32.5 + r * Math.sin(a + 0.9);
      blades += `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
    }
    return `<circle cx="32" cy="32.5" r="12.5" ${W}/>
      <path d="${blades}" ${D(d)} stroke-width="1.8"/>
      <circle cx="32" cy="32.5" r="4.5" fill="${d}"/>
      <path d="M32 16v-3M44.5 20.5l2-2M48.5 32.5h3M19.5 20.5l-2-2M15.5 32.5h-3" ${S} stroke-width="2"/>`;
  },
  // a journal with a ribbon bookmark
  diarist: (d) => `<rect x="21.5" y="18.5" width="21" height="27" rx="2.5" ${W}/>
    <path d="M25.5 18.5v27" ${D(d)} stroke-width="1.6"/>
    <path d="M36 18.5v9.5l2.2-1.8 2.2 1.8v-9.5" fill="${d}"/>
    <path d="M29 31h9M29 35h9M29 39h6" ${D(d)} stroke-width="1.5" stroke-opacity=".6"/>`,
  // an hourglass
  chronicler: (d) => `<path d="M22 18.5h20M22 46.5h20" ${S} stroke-width="3"/>
    <path d="M24.5 19.5h15c0 7-7.5 9.5-7.5 13s7.5 6 7.5 13h-15c0-7 7.5-9.5 7.5-13s-7.5-6-7.5-13z" ${W}/>
    <path d="M27.5 24h9c-1 2.5-4.5 4-4.5 5.5 0-1.5-3.5-3-4.5-5.5zM26.8 44c.8-3.5 5.2-5.3 5.2-7.5 0 2.2 4.4 4 5.2 7.5z" fill="${d}"/>
    <path d="M32 32.5v3" ${D(d)} stroke-width="1.2"/>`,
  // the sun and the moon
  keeper_of_days: (d) => `<circle cx="28" cy="30" r="7.5" ${W}/>
    <path d="M28 18.5v-2.5M28 44v-2.5M16.5 30H14M19.9 21.9l-1.8-1.8M19.9 38.1l-1.8 1.8M36.1 21.9l1.8-1.8" ${S} stroke-width="2.2"/>
    <path d="M41.5 29a9.5 9.5 0 1 0 7.2 13.8A8 8 0 0 1 41.5 29z" fill="${d}" stroke="#fff" stroke-width="2"/>
    <circle cx="44" cy="23" r="1.3" fill="#fff"/><circle cx="48.5" cy="28" r="1" fill="#fff"/>`,
  // a rally flag
  party_leader: (d) => `<path d="M23.5 47V18.5" ${S} stroke-width="2.8"/>
    <path d="M24.5 19.5h17l-4.5 5.8 4.5 5.8h-17z" ${W}/>
    <path d="M30.5 22.7l.9 1.9 2.1.3-1.5 1.5.4 2.1-1.9-1-1.9 1 .4-2.1-1.5-1.5 2.1-.3z" fill="${d}"/>
    <circle cx="23.5" cy="17.5" r="2" fill="#fff"/>`,
  // crossed swords
  guild_master: (d) => `<path d="M21 19.5l17 17M43 19.5l-17 17" ${S} stroke-width="3.4"/>
    <path d="M34.5 40l6-6M29.5 40l-6-6" ${S} stroke-width="3"/>
    <path d="M38.5 38.5l4.5 4.5M25.5 38.5L21 43" ${S} stroke-width="3.4"/>
    <circle cx="44.2" cy="44.2" r="2.2" fill="#fff"/><circle cx="19.8" cy="44.2" r="2.2" fill="#fff"/>
    <path d="M22.5 21l14 14M41.5 21l-14 14" ${D(d)} stroke-width="1" stroke-opacity=".5"/>`,
  // an orb and cross
  sovereign: (d) => `<circle cx="32" cy="36.5" r="9.5" ${W}/>
    <path d="M22.8 35.5h18.4M32 27v19" ${D(d)} stroke-width="1.8"/>
    <path d="M32 26.5v-9M28.3 21h7.4" ${S} stroke-width="3"/>
    <circle cx="27.5" cy="40.5" r="1.4" fill="${d}"/><circle cx="36.5" cy="40.5" r="1.4" fill="${d}"/>`,
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
  // two friends side by side
  good_company: (d) => `<circle cx="37" cy="27" r="4" fill="#fff" fill-opacity=".65"/>
    <path d="M30.5 41c.4-5.5 3-8.3 6.5-8.3 3.8 0 6.6 3 6.6 8.3z" fill="#fff" fill-opacity=".65"/>
    <circle cx="28" cy="28.5" r="4.6" ${W} stroke="${d}" stroke-width="1.2"/>
    <path d="M20 43c0-6 3.3-9.6 8-9.6s8 3.6 8 9.6z" ${W} stroke="${d}" stroke-width="1.2"/>`,
  // a ring of friends
  circle: (d) => ring(d),
  // a butterfly
  butterfly: (d) => `<path d="M31 31c-2.5-6.5-8.5-10.5-11.8-8.2-2.6 1.9-.4 8.5 5.6 9.7-4.8 1-6.4 5.8-3.8 7.7 2.8 2 7.4-1.8 10-7.2z" ${W}/>
    <path d="M33 31c2.5-6.5 8.5-10.5 11.8-8.2 2.6 1.9.4 8.5-5.6 9.7 4.8 1 6.4 5.8 3.8 7.7-2.8 2-7.4-1.8-10-7.2z" ${W}/>
    <path d="M32 26.5v12M32 26.5l-2.4-3.8M32 26.5l2.4-3.8" ${D(d)} stroke-width="2.2"/>
    <circle cx="24" cy="27.5" r="1.5" fill="${d}" fill-opacity=".6"/><circle cx="40" cy="27.5" r="1.5" fill="${d}" fill-opacity=".6"/>`,
  // a crowned heart
  heart: (d) => `<path d="M32 45.5s-12.5-7.2-12.5-15.4a6.6 6.6 0 0 1 12.5-3 6.6 6.6 0 0 1 12.5 3c0 8.2-12.5 15.4-12.5 15.4z" ${W}/>
    <path d="M27 22.5l-1-5 3.3 2.4L32 16l2.7 3.9 3.3-2.4-1 5z" ${W}/>
    <path d="M26.5 31.5c.3-1.8 1.6-3 3.3-3.2" ${D(d)} stroke-opacity=".7"/>`,
  // a sealed envelope
  courier: (d) => `<rect x="19.5" y="23.5" width="25" height="18" rx="2.2" ${W}/>
    <path d="M20.5 25l11.5 9 11.5-9M20.5 40.5l8.5-7.5M43.5 40.5l-8.5-7.5" ${D(d)}/>`,
  // a herald's horn
  herald: (d) => `<path d="M19.5 29.5h4.5l13-7.5v21.5l-13-7.5h-4.5a1.5 1.5 0 0 1-1.5-1.5v-3.5a1.5 1.5 0 0 1 1.5-1.5z" ${W}/>
    <path d="M22.5 36l2 8h3.5l-1.8-7.8" ${W}/>
    <path d="M41.5 27.5c2 1.8 2.8 3.5 2.8 5.3s-.8 3.5-2.8 5.3M45 24.5c3 2.5 4.2 5.3 4.2 8.3s-1.2 5.8-4.2 8.3" ${S} stroke-width="2.2"/>
    <path d="M24 30v5.5" ${D(d)} stroke-width="1.6"/>`,
  // a letter with a wax seal
  emissary: (d) => `<path d="M21.5 20.5h17.5a3 3 0 0 1 3 3v19H24.5a3 3 0 0 1-3-3z" ${W}/>
    <path d="M25.5 26h11M25.5 30h11M25.5 34h7" ${D(d)} stroke-width="1.6"/>
    <path d="M38 41.5l-2 6 3.2-1.5 1.8 2.6 1-6.5M42 41.5l2 6-3.2-1.5" fill="${d}" stroke="none"/>
    <circle cx="40" cy="40" r="5" fill="#b3202a" stroke="#fff" stroke-width="1.2"/>
    <circle cx="40" cy="40" r="2.2" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="1"/>`,
  // a black raven, perched
  ravens: () => {
    const K = 'fill="#161a26" stroke="none"';
    return `<circle cx="37.5" cy="24.5" r="5.4" ${K}/>
    <path d="M41.5 21.8l8.8 3.3-8.6 2.6z" ${K}/>
    <path d="M33.5 26.8c-8.3.6-14 7.6-14 14.7l-5.8 5.8h12c7.8 0 13.9-5.7 14.7-12.6.4-3.6-.7-6.3-2.4-8.1z" ${K}/>
    <circle cx="39" cy="23.4" r="1.3" fill="#fff"/>
    <path d="M24.5 36.5c4.7-.4 9.2 1.4 11.8 4.9M23 40.5c3.2-.2 6.3.8 8.3 2.9" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M29.5 46.5v3.5M34 46v3.8M27.5 50h4M32 49.8h4" fill="none" stroke="#161a26" stroke-width="1.8" stroke-linecap="round"/>`;
  },
  // ----- time online (account shields) -----
  // a lit candle
  lamplighter: (d) => `<path d="M32 13.5c3 3.4 4.4 5.8 4.4 8.2a4.4 4.4 0 0 1-8.8 0c0-2.4 1.4-4.8 4.4-8.2z" ${W}/>
    <path d="M32 19.5c1.2 1.5 1.8 2.6 1.8 3.6a1.8 1.8 0 0 1-3.6 0c0-1 .6-2.1 1.8-3.6z" fill="${d}"/>
    <path d="M32 26.5v2" ${D(d)} stroke-width="1.4"/>
    <rect x="27" y="28.5" width="10" height="15" rx="1.4" ${W}/>
    <path d="M30 28.5v4.5" ${D(d)} stroke-width="1.4" stroke-opacity=".5"/>
    <path d="M22 43.5h20a2.5 2.5 0 0 1-2.5 3h-15a2.5 2.5 0 0 1-2.5-3z" ${W}/>`,
  // a watchman's lantern
  night_watch: (d) => `<path d="M28.5 18a3.5 3.5 0 0 1 7 0" ${S} stroke-width="2.2"/>
    <path d="M25 19.5h14l-1.5 3h-11z" ${W}/>
    <rect x="25.5" y="22.5" width="13" height="18" rx="1.5" ${W}/>
    <rect x="28" y="25" width="8" height="13" rx="1" fill="${d}"/>
    <path d="M32 27.5c1.8 2 2.6 3.5 2.6 5a2.6 2.6 0 0 1-5.2 0c0-1.5.8-3 2.6-5z" fill="#ffd66b"/>
    <path d="M24.5 40.5h15l1.5 3h-18z" ${W}/>`,
  // a hearth fire
  hearthkeeper: (d) => `<path d="M32 16c5.5 5.5 8 9.5 8 14a8 8 0 0 1-16 0c0-3 1.3-5.4 3.3-7.5.3 2.4 1.4 3.8 3 4.5-.8-3.8.2-7.4 1.7-11z" ${W}/>
    <path d="M32 27c2.3 2.4 3.3 4.2 3.3 6a3.3 3.3 0 0 1-6.6 0c0-1.8 1-3.6 3.3-6z" fill="${d}"/>
    <path d="M20.5 45l23-6.5M43.5 45l-23-6.5" ${S} stroke-width="3.2"/>`,
  // a flame burning in a brazier
  eternal_flame: (d) => `<path d="M32 12.5c6 6.2 9 10.6 9 15.4a9 9 0 0 1-18 0c0-3.4 1.5-6 3.8-8.4.3 2.7 1.5 4.2 3.3 5-1-4.3.3-8.1 1.9-12z" ${W}/>
    <path d="M32 24.5c2.6 2.7 3.8 4.7 3.8 6.8a3.8 3.8 0 0 1-7.6 0c0-2.1 1.2-4.1 3.8-6.8z" fill="${d}"/>
    <path d="M21 37.5h22l-3 5.5H24z" ${W}/>
    <path d="M28 43l-2 5M36 43l2 5M24.5 48h15" ${S} stroke-width="2.4"/>`,
  // ----- chat likes (drawn inside a heart) -----
  // a thrown rose
  crowd_pleaser: (d) => `<path d="M32 46.5V31" ${S} stroke-width="2.6"/>
    <path d="M32 40.5c-3.8-2.6-8-2.2-9.8.6 3.4 2.2 7.2 1.8 9.8-.6zM32 37c3.2-2.4 7-2.2 8.8.4-3 2-6.6 1.8-8.8-.4z" ${W}/>
    <path d="M32 31.5c-5.8 0-9.2-3.6-9.2-8.2 0-3 1.8-5.4 4.4-6.6 1 2.2 2.8 3.4 4.8 3.4s3.8-1.2 4.8-3.4c2.6 1.2 4.4 3.6 4.4 6.6 0 4.6-3.4 8.2-9.2 8.2z" ${W}/>
    <path d="M27.8 23.2c1.4 2.4 6.8 2.6 8.4-.2M29.5 27.2c1.6 1 3.6 1 5 0" ${D(d)} stroke-width="1.6"/>`,
  // a lute
  beloved_bard: (d) => `<g transform="rotate(-38 32 32)">
    <rect x="30.3" y="12.5" width="3.4" height="19" rx="1" ${W}/><rect x="29" y="9.5" width="6" height="4.5" rx="1.2" ${W}/>
    <ellipse cx="32" cy="39.5" rx="9.5" ry="10.5" ${W}/>
    <circle cx="32" cy="37.5" r="3" fill="${d}"/>
    <path d="M31 16v29M33 16v29" ${D(d)} stroke-width=".8"/>
    <rect x="28.3" y="44" width="7.4" height="2" rx=".7" fill="${d}"/></g>`,
  // two goblets raised in a toast
  toast_of_tavern: (d) => {
    const goblet = (x: number, a: number) => `<g transform="translate(${x} 22) rotate(${a})">
      <path d="M-7 0h14c0 8-3.4 11.5-7 11.5S-7 8-7 0z" ${W}/><path d="M-5.2 3.2h10.4c-.6 4.4-2.6 6.4-5.2 6.4s-4.6-2-5.2-6.4z" fill="${d}"/>
      <path d="M0 11.5v8M-4.5 19.5h9" ${S} stroke-width="2.4"/></g>`;
    return `${goblet(25, -16)}${goblet(39, 16)}<path d="M32 16.5v-4.5M27.5 17.5l-2.4-3.4M36.5 17.5l2.4-3.4" ${S} stroke-width="2"/>`;
  },
  // a laurel wreath around a star
  living_legend: (d) => {
    let leaves = '';
    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const deg = 100 + i * 26, a = (deg * Math.PI) / 180;
        const x = 32 + side * -13 * Math.cos(a), y = 34 - 13 * Math.sin(a) * -1;
        const rot = side < 0 ? deg - 90 + 180 : 90 - deg;
        leaves += `<ellipse cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" rx="3.6" ry="1.7" transform="rotate(${rot.toFixed(1)} ${x.toFixed(2)} ${y.toFixed(2)})" ${W}/>`;
      }
    }
    return `${leaves}
      <path d="M32 24.5l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.6-5 2.6.9-5.6-4-4 5.6-.8z" ${W} stroke="${d}" stroke-width=".8"/>`;
  },
  // a radiant star
  luminary: (d) => `${rays()}
    <path d="M32 21.5l3.2 6.6 7.2 1-5.2 5.1 1.2 7.2-6.4-3.4-6.4 3.4 1.2-7.2-5.2-5.1 7.2-1z" ${W} stroke="${d}" stroke-width="1"/>
    <circle cx="32" cy="32.5" r="2" fill="${d}" fill-opacity=".45"/>`,
};

/** Twelve light rays, long and short, behind the star. */
function rays(): string {
  let out = '';
  for (let i = 0; i < 12; i++) {
    const a = (Math.PI * 2 * i) / 12 - Math.PI / 2, r1 = 13.5, r2 = i % 2 ? 17 : 20;
    const p = (r: number) => `${(32 + r * Math.cos(a)).toFixed(2)} ${(32.5 + r * Math.sin(a)).toFixed(2)}`;
    out += `M${p(r1)}L${p(r2)}`;
  }
  return `<path d="${out}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-opacity=".85"/>`;
}

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

function frame(group: TrophyGroup, fill: string, edge: string, dark: string, heart = false): string {
  if (heart) {
    return `<path d="M32 60C19 50.5 3 39.5 3 22.5 3 12.5 10.5 5.5 19 5.5c5.8 0 10.4 3.3 13 7.8 2.6-4.5 7.2-7.8 13-7.8 8.5 0 16 7 16 17 0 17-16 28-29 37.5z" fill="${dark}"/>
      <path d="M32 54.5C20.5 46 8 36.5 8 22.8 8 15.2 13.6 10 20 10c5.4 0 9.6 3.4 12 8.4 2.4-5 6.6-8.4 12-8.4 6.4 0 12 5.2 12 12.8 0 13.7-12.5 23.2-24 31.7z" fill="${fill}" stroke="${edge}" stroke-width="1.2"/>`;
  }
  if (group === 'account') {
    return `<path d="M32 3.5l24 8.5v17.5c0 15.5-10.5 26-24 31-13.5-5-24-15.5-24-31V12z" fill="${dark}"/>
      <path d="M32 7.5l20 7v15c0 13-8.8 22-20 26.5-11.2-4.5-20-13.5-20-26.5v-15z" fill="${fill}" stroke="${edge}" stroke-width="1.2"/>`;
  }
  if (group === 'photos') {
    // an instant photo: cream card, coloured picture area (the emblem is shrunk to fit it)
    return `<rect x="8.5" y="4.5" width="47" height="55" rx="3" fill="#f6f2e8" stroke="${dark}" stroke-width="2"/>
      <rect x="12.5" y="8.5" width="39" height="36" rx="1" fill="${fill}" stroke="${edge}" stroke-width="1"/>
      <path d="M17 52.5h14" stroke="${dark}" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/>`;
  }
  if (group === 'mail') {
    // a postage stamp with perforated edges
    let bumps = '';
    for (let i = 0; i <= 8; i++) {
      const v = (8 + i * 6).toFixed(1);
      bumps += `<circle cx="${v}" cy="8" r="2.6"/><circle cx="${v}" cy="56" r="2.6"/><circle cx="8" cy="${v}" r="2.6"/><circle cx="56" cy="${v}" r="2.6"/>`;
    }
    return `<g fill="${dark}">${bumps}<rect x="8" y="8" width="48" height="48"/></g>
      <rect x="11.5" y="11.5" width="41" height="41" rx="1.5" fill="${fill}" stroke="${edge}" stroke-width="1.2"/>`;
  }
  if (group === 'social') {
    return `<path d="M32 2.5l29.5 29.5L32 61.5 2.5 32z" fill="${dark}" stroke="${dark}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M32 7.5L56.5 32 32 56.5 7.5 32z" fill="${fill}" stroke="${edge}" stroke-width="1.2" stroke-linejoin="round"/>`;
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
    ${frame(t?.group ?? 'time', `url(#${g})`, shade(base, 0.55), dark, t?.metric === 'likes')}
    ${t?.group === 'photos' ? `<g transform="translate(32 26.5) scale(.8) translate(-32 -32.5)">${(EMBLEM[id] ?? (() => ''))(dark)}</g>`
      : t?.metric === 'likes' ? `<g transform="translate(32 29) scale(.66) translate(-32 -32)">${(EMBLEM[id] ?? (() => ''))(dark)}</g>`
      : (EMBLEM[id] ?? (() => ''))(dark)}
  </svg>`;
  const el = h('span', { class: `trophy-badge${opts.locked ? ' locked' : ''}` });
  el.innerHTML = svg; // built only from the fixed strings above
  return el;
}
