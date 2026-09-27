import { CHAT } from '../shared/config.js';

export interface Paged<T> {
  items: T[]; // oldest → newest
  page: number; // 1 = newest
  totalPages: number;
  olderCursor: string | null;
  newerCursor: string | null;
}

/**
 * Cursor paging over a room's visible messages.
 *
 * `newestFirst` is at most RETAINED_PER_ROOM (200) rows already filtered for the viewer
 * (ignores, shadow, hidden), so slicing in memory is cheap and gives exact page counts.
 * Cursors are message ids, so messages arriving while someone reads old pages never
 * cause duplicates or skipped lines.
 */
export function paginate<T extends { id: string }>(
  newestFirst: T[],
  opts: { before?: string; after?: string } = {},
  pageSize: number = CHAT.PAGE_SIZE,
): Paged<T> {
  const n = newestFirst.length;
  const totalPages = Math.max(1, Math.ceil(n / pageSize));
  let start = 0;

  if (opts.before) {
    const before = BigInt(opts.before);
    const idx = newestFirst.findIndex((m) => BigInt(m.id) < before);
    // Cursor older than anything kept (pruned) → show the oldest kept page.
    start = idx === -1 ? Math.max(0, (totalPages - 1) * pageSize) : idx;
  } else if (opts.after) {
    const after = BigInt(opts.after);
    const newerCount = newestFirst.filter((m) => BigInt(m.id) > after).length;
    start = Math.max(0, newerCount - pageSize);
  }

  const window = newestFirst.slice(start, start + pageSize);
  const items = [...window].reverse();
  return {
    items,
    page: Math.min(totalPages, Math.floor(start / pageSize) + 1),
    totalPages,
    olderCursor: start + pageSize < n && items.length ? items[0].id : null,
    newerCursor: start > 0 && items.length ? items[items.length - 1].id : null,
  };
}
