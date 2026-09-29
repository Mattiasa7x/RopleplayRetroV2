import { GIFT_BY_ID, GIFT_THEME_BY_ID } from '../../shared/gifts.js';
import { h } from './dom.js';

/** A gift as a small coloured tile (the theme's colour) with its picture. */
export function giftTile(id: string, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const g = GIFT_BY_ID.get(id);
  const color = GIFT_THEME_BY_ID.get(g?.theme ?? '')?.color ?? '#888';
  const el = h('span', { class: `gift-tile ${size}`, role: 'img', 'aria-label': g?.name ?? 'Gift' },
    h('span', { class: 'gift-emoji', 'aria-hidden': 'true' }, g?.emoji ?? '🎁'));
  el.style.setProperty('--gift', color);
  return el;
}

export const giftName = (id: string) => GIFT_BY_ID.get(id)?.name ?? 'Gift';
