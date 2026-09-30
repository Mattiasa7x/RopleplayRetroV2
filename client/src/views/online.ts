import type { OnlineUserDTO, OnlineUsersDTO } from '../../../shared/types.js';
import { avatar, card, page, state, toast } from '../core.js';
import { api, h } from '../dom.js';

/** One member in an Online Users list: picture, name, nameplate and "33, M, Hyrule". */
export function onlineUserRow(u: OnlineUserDTO): HTMLElement {
  return h('li', {},
    h('a', { href: `/profile/${u.handle}`, class: 'person-link online-person' },
      h('span', { class: 'avatar-wrap' }, avatar(u.avatar, u.handle, 'md', u.quill), u.online === false ? null : h('span', { class: 'dot', 'aria-hidden': 'true' })),
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

/**
 * Find members: Online and Offline tabs sharing one search box, each A to Z, with a picture
 * filter. (The Home page card still shows online members only.)
 */
export async function viewPeople() {
  const params = new URLSearchParams(location.search);
  let status: 'online' | 'offline' = params.get('tab') === 'offline' ? 'offline' : 'online';
  let pic: 'any' | 'yes' | 'no' = params.get('pic') === 'yes' || params.get('pic') === 'no' ? params.get('pic') as 'yes' | 'no' : 'any';
  const search = h('input', { type: 'search', placeholder: 'Search by name', 'aria-label': 'Search members by name', maxlength: 16, autocomplete: 'off', autocapitalize: 'off', value: params.get('q') ?? '' });
  const count = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const list = h('ul', { class: 'people online-list' });
  const pager = h('div', { class: 'pager' });
  let timer: number | undefined;
  let seq = 0;

  const tabBtn = (id: 'online' | 'offline', label: string) => {
    const b = h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': 'false' }, label);
    b.addEventListener('click', () => { status = id; paint(); void load(1); });
    return { id, b };
  };
  const tabs = [tabBtn('online', '● Online'), tabBtn('offline', 'Offline')];
  const chip = (id: 'any' | 'yes' | 'no', label: string) => {
    const b = h('button', { type: 'button', class: 'filter-chip', 'aria-pressed': 'false' }, label);
    b.addEventListener('click', () => { pic = id; paint(); void load(1); });
    return { id, b };
  };
  const chips = [chip('any', 'Everyone'), chip('yes', 'With picture'), chip('no', 'No picture')];
  function paint() {
    for (const t of tabs) { const on = t.id === status; t.b.classList.toggle('active', on); t.b.setAttribute('aria-selected', String(on)); }
    for (const c of chips) { const on = c.id === pic; c.b.classList.toggle('active', on); c.b.setAttribute('aria-pressed', String(on)); }
  }

  async function load(p = 1) {
    const mine = ++seq;
    const q = search.value.trim();
    const qs = new URLSearchParams({ status, pic, q, page: String(p) });
    try {
      const d = await api<OnlineUsersDTO>(`/api/members?${qs}`);
      if (mine !== seq) return; // a newer search already replaced this one
      if (d.page > d.pages) return void load(1);
      const what = status === 'online' ? 'online' : 'offline';
      count.textContent = `${d.total.toLocaleString()} ${what} member${d.total === 1 ? '' : 's'}${q || pic !== 'any' ? ' match' : ''}`;
      list.replaceChildren(...(d.users.length ? d.users.map(onlineUserRow)
        : [h('li', { class: 'muted' }, q || pic !== 'any' ? `No ${what} members match.` : status === 'online' ? 'Nobody else is online right now.' : 'No offline members.')]));
      pager.replaceChildren(...(d.pages > 1 ? [
        h('button', { type: 'button', class: 'quiet', disabled: d.page <= 1, onclick: (() => void load(d.page - 1)) as EventListener }, '‹ Prev'),
        h('span', { class: 'muted small' }, `Page ${d.page} of ${d.pages}`),
        h('button', { type: 'button', class: 'quiet', disabled: d.page >= d.pages, onclick: (() => void load(d.page + 1)) as EventListener }, 'Next ›'),
      ] : []));
      const keep = new URLSearchParams();
      if (status === 'offline') keep.set('tab', 'offline');
      if (pic !== 'any') keep.set('pic', pic);
      if (q) keep.set('q', q);
      history.replaceState({}, "", `/people${keep.toString() ? `?${keep}` : ""}`);
    } catch (e) { toast((e as Error).message, true); }
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(() => void load(1), 300); });

  paint();
  page('Members',
    h('a', { href: '/home', class: 'back' }, '‹ Home'),
    card('Find friends and writing partners',
      h('div', { class: 'tabs-row people-tabs', role: 'tablist', 'aria-label': 'Online or offline' }, ...tabs.map((t) => t.b)),
      search,
      h('div', { class: 'filter-row', role: 'group', 'aria-label': 'Profile picture' }, ...chips.map((c) => c.b)),
      count, list, pager));
  await load(1);
}
