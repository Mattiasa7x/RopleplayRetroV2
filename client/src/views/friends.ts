import type { FriendsDTO, PublicUser } from '../../../shared/types.js';
import { avatar, card, field, form, page, state, toast } from '../core.js';
import { api, h } from '../dom.js';

export function person(u: PublicUser, ...buttons: (Element | null)[]): HTMLElement {
  return h('li', { class: 'person' },
    h('a', { href: `/profile/${u.handle}`, class: 'person-link' },
      h('span', { class: 'avatar-wrap' }, avatar(u.avatar, u.handle, 'md', u.quill), u.online ? h('span', { class: 'dot', 'aria-label': 'online' }) : null),
      h('span', {}, h('strong', {}, u.handle, u.isFamily ? h('span', { class: 'tag friend-tag family-tag' }, 'family') : null),
        u.online !== undefined ? h('span', { class: 'muted small block' }, u.online ? 'Online' : 'Offline') : null)),
    h('span', { class: 'row' }, ...(buttons.filter(Boolean) as Element[])));
}

/**
 * Your friends, online first then A to Z, with an All / Family switch. Tagging someone as
 * family is your own label: it replaces the "friend" badge wherever you see them.
 */
function friendsCard(friends: PublicUser[]): HTMLElement {
  let only: 'all' | 'family' = new URLSearchParams(location.search).get('tab') === 'family' ? 'family' : 'all';
  const list = h('ul', { class: 'people' });
  const familyBtn = (u: PublicUser) => {
    const b = h('button', { type: 'button', class: `quiet family-toggle${u.isFamily ? ' on' : ''}`, 'aria-pressed': String(!!u.isFamily),
      'aria-label': u.isFamily ? `Untag ${u.handle} as family` : `Tag ${u.handle} as family` }, u.isFamily ? '✓ Family' : '+ Family');
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/api/friends/${encodeURIComponent(u.handle)}/family`, { method: u.isFamily ? 'DELETE' : 'PUT', body: {} });
        u.isFamily = !u.isFamily;
        toast(u.isFamily ? `${u.handle} is tagged as family.` : `${u.handle} is no longer tagged as family.`);
        paint();
      } catch (e) { toast((e as Error).message, true); b.disabled = false; }
    });
    return b;
  };
  const tabs = (['all', 'family'] as const).map((id) => {
    const b = h('button', { type: 'button', role: 'tab', class: 'tab' });
    b.addEventListener('click', () => { only = id; paint(); });
    return { id, b };
  });
  function paint() {
    const fam = friends.filter((f) => f.isFamily);
    tabs[0].b.textContent = `All (${friends.length})`;
    tabs[1].b.textContent = `Family (${fam.length})`;
    for (const t of tabs) { const on = t.id === only; t.b.classList.toggle('active', on); t.b.setAttribute('aria-selected', String(on)); }
    const shown = only === 'family' ? fam : friends;
    list.replaceChildren(...(shown.length
      ? shown.map((u) => person(u, familyBtn(u), h('a', { href: `/messages/${u.handle}`, class: 'button quiet', 'aria-label': `Message ${u.handle}` }, '✉')))
      : [h('li', { class: 'muted' }, only === 'family' ? 'Nobody tagged as family yet. Tap + Family next to a friend.' : 'No friends yet. Tap a name in any room to add them.')]));
    history.replaceState({}, '', only === 'family' ? '/friends?tab=family' : '/friends');
  }
  paint();
  return card('Friends',
    h('div', { class: 'tabs-row', role: 'tablist', 'aria-label': 'Which friends' }, ...tabs.map((t) => t.b)),
    list);
}

export async function viewFriends() {
  page('Friends', h('p', { class: 'muted' }, 'Loading…'));
  const d = await api<FriendsDTO>('/api/friends');
  state.friendRequests = d.incoming.length;
  const reload = () => void viewFriends();
  const act = (label: string, cls: string, fn: () => Promise<unknown>, ok?: string) =>
    h('button', { type: 'button', class: cls, onclick: (async () => {
      try { await fn(); if (ok) toast(ok); reload(); } catch (e) { toast((e as Error).message, true); }
    }) as EventListener }, label);

  const add = form([field('Add a friend by name', 'handle', 'text', { maxlength: 16, autocapitalize: 'off', autocomplete: 'off' })], 'Send request', async (fd, err) => {
    const handle = String(fd.get('handle')).trim();
    try {
      const r = await api<{ state: string }>(`/api/friends/${encodeURIComponent(handle)}`, { body: {} });
      toast(r.state === 'friends' ? `You and ${handle} are now friends.` : `Request sent to ${handle}.`);
      reload();
    } catch (x) { err((x as Error).message); }
  }, 'inline-form');

  page('Friends',
    d.incoming.length ? card(`Requests (${d.incoming.length})`, h('ul', { class: 'people' }, ...d.incoming.map((u) => person(u,
      act('Accept', 'primary', () => api(`/api/friends/${u.handle}`, { body: {} }), `You and ${u.handle} are now friends.`),
      act('Decline', 'quiet', () => api(`/api/friends/${u.handle}`, { method: 'DELETE' })))))) : null,
    friendsCard(d.friends),
    card('Add a friend', add),
    d.outgoing.length ? card('Sent requests', h('ul', { class: 'people' }, ...d.outgoing.map((u) => person(u,
      act('Cancel', 'quiet', () => api(`/api/friends/${u.handle}`, { method: 'DELETE' }))))) ) : null);
}
