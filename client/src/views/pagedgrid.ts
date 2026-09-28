import { h } from '../dom.js';

/**
 * Shows `items` a page at a time (default 6: two rows of three) with Previous / Next,
 * so every picture is seen whole instead of squeezed into a scrolling box.
 * Opens on the page holding `startIndex` (e.g. the currently chosen picture).
 */
export function pagedGrid(items: HTMLElement[], opts: { perPage?: number; startIndex?: number; className: string; label: string }): HTMLElement {
  const per = opts.perPage ?? 6;
  const pages = Math.max(1, Math.ceil(items.length / per));
  let page = Math.min(pages - 1, Math.floor(Math.max(0, opts.startIndex ?? 0) / per));
  const grid = h('div', { class: opts.className, role: 'group', 'aria-label': opts.label });
  const prev = h('button', { type: 'button', class: 'quiet', 'aria-label': 'Previous page' }, '‹ Prev');
  const next = h('button', { type: 'button', class: 'quiet', 'aria-label': 'Next page' }, 'Next ›');
  const where = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const paint = () => {
    grid.replaceChildren(...items.slice(page * per, page * per + per));
    where.textContent = `Page ${page + 1} of ${pages}`;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
  };
  prev.addEventListener('click', () => { page--; paint(); });
  next.addEventListener('click', () => { page++; paint(); });
  paint();
  return h('div', { class: 'paged-grid' }, grid, pages > 1 ? h('div', { class: 'pager paged-nav' }, prev, where, next) : null);
}
