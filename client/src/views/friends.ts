import type { FriendsDTO, PublicUser } from '../../../shared/types.js';
import { avatar, card, field, form, page, state, toast } from '../core.js';
import { api, h } from '../dom.js';

export function person(u: PublicUser, ...buttons: (Element | null)[]): HTMLElement {
  return h('li', { class: 'person' },
    h('a', { href: `/profile/${u.handle}`, class: 'person-link' },
      h('span', { class: 'avatar-wrap' }, avatar(u.avatar, u.handle, 'md', u.quill), u.online ? h('span', { class: 'dot', 'aria-label': 'online' }) : null),
      h('span', {}, h('strong', {}, u.handle), u.online !== undefined ? h('span', { class: 'muted small block' }, u.online ? 'Online' : 'Offline') : null)),
    h('span', { class: 'row' }, ...(buttons.filter(Boolean) as Element[])));
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
    card(`Friends (${d.friends.length})`,
      d.friends.length
        ? h('ul', { class: 'people' }, ...d.friends.map((u) => person(u, h('a', { href: `/messages/${u.handle}`, class: 'button quiet', 'aria-label': `Message ${u.handle}` }, '✉'))))
        : h('p', { class: 'muted' }, 'No friends yet. Tap a name in any room to add them.'),
      add),
    d.outgoing.length ? card('Sent requests', h('ul', { class: 'people' }, ...d.outgoing.map((u) => person(u,
      act('Cancel', 'quiet', () => api(`/api/friends/${u.handle}`, { method: 'DELETE' }))))) ) : null);
}
