import type { OnlineUserDTO, OnlineUsersDTO } from '../../../shared/types.js';
import { avatar, card, page, state, toast } from '../core.js';
import { api, h } from '../dom.js';

/** One member in an Online Users list: picture, name, nameplate and "33, M, Hyrule". */
export function onlineUserRow(u: OnlineUserDTO): HTMLElement {
  return h('li', {},
    h('a', { href: `/profile/${u.handle}`, class: 'person-link online-person' },
      h('span', { class: 'avatar-wrap' }, avatar(u.avatar, u.handle, 'md', u.quill), h('span', { class: 'dot', 'aria-hidden': 'true' })),
      h('span', { class: 'person-text' },
        h('strong', {}, u.handle, u.isFriend ? h('span', { class: 'tag friend-tag' }, 'friend') : null),
        u.rpStyle ? h('span', { class: 'nameplate small-plate' }, u.rpStyle) : null,
        h('span', { class: 'muted small block' }, u.characterLine ?? ''))));
}

/** Home page card: up to 5 online members picked at random. */
export async function onlineCard(): Promise<HTMLElement | null> {
  let d: OnlineUsersDTO;
  try { d = await api<OnlineUsersDTO>('/api/online?sample=1'); } catch { return null; }
  return card(null,
    h('a', { href: '/people', class: 'card-title-link' }, h('h2', {}, 'Online Users'), h('span', { class: 'muted small' }, `${d.total} online ›`)),
    d.users.length
      ? h('ul', { class: 'people online-list' }, ...d.users.map(onlineUserRow))
      : h('p', { class: 'muted' }, 'Nobody else is online right now. Check back soon.'),
    h('a', { href: '/people', class: 'button quiet wide' }, 'Find friends and writing partners'));
}

/** Search every online member, A to Z. */
export async function viewPeople() {
  const search = h('input', { type: 'search', placeholder: 'Search by name', 'aria-label': 'Search online members by name', maxlength: 16, autocomplete: 'off', autocapitalize: 'off' });
  const count = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const list = h('ul', { class: 'people online-list' });
  const pager = h('div', { class: 'pager' });
  let timer: number | undefined;

  async function load(p = 1) {
    try {
      const d = await api<OnlineUsersDTO>(`/api/online?page=${p}&q=${encodeURIComponent(search.value.trim())}`);
      count.textContent = search.value.trim() ? `${d.total} online member${d.total === 1 ? '' : 's'} match` : `${d.total} member${d.total === 1 ? '' : 's'} online`;
      list.replaceChildren(...(d.users.length ? d.users.map(onlineUserRow) : [h('li', { class: 'muted' }, search.value.trim() ? 'No one online by that name.' : 'Nobody else is online right now.')]));
      pager.replaceChildren(...(d.pages > 1 ? [
        h('button', { type: 'button', class: 'quiet', disabled: d.page <= 1, onclick: (() => void load(d.page - 1)) as EventListener }, '‹ Prev'),
        h('span', { class: 'muted small' }, `Page ${d.page} of ${d.pages}`),
        h('button', { type: 'button', class: 'quiet', disabled: d.page >= d.pages, onclick: (() => void load(d.page + 1)) as EventListener }, 'Next ›'),
      ] : []));
    } catch (e) { toast((e as Error).message, true); }
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(() => void load(1), 300); });

  page('Online Users',
    h('a', { href: '/home', class: 'back' }, '‹ Home'),
    card('Find friends and writing partners',
      h('p', { class: 'muted small' }, 'Everyone online right now, A to Z.'),
      search, count, list, pager));
  await load(1);
}
