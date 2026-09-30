import type { FriendsDTO, PhotoDTO, ProfileDTO, PublicUser } from '../../../shared/types.js';
import { avatar, card, state, toast } from '../core.js';
import { api, h } from '../dom.js';
import { reportContent } from './home.js';
import { uploadPhotos } from './photos.js';

/**
 * Public photos and the private album, as two tabs. With `manage` (the owner, on Edit profile)
 * every photo gets its tools and the upload buttons show; otherwise it's the visitor's view.
 */
export async function photoSection(p: ProfileDTO, opts: { manage: boolean; reload: () => void }): Promise<HTMLElement> {
  const me = state.me!;
  const self = p.friendState === 'self';
  const manage = opts.manage && self;
  const reload = opts.reload;
  const call = (fn: () => Promise<unknown>, ok?: string) => async () => {
    try { await fn(); if (ok) toast(ok); reload(); } catch (e) { toast((e as Error).message, true); }
  };
  const btn = (label: string, cls: string, fn: () => void) => h('button', { type: 'button', class: cls, onclick: fn as EventListener }, label);

  const photoGrid = (photos: PhotoDTO[], inAlbum: boolean) => h('ul', { class: 'photo-grid' }, ...photos.map((ph, i) => h('li', {},
    h('a', { href: `/photo/${ph.id}`, class: 'photo', 'aria-label': `Open photo ${i + 1}` },
      h('img', { src: ph.thumb, alt: '', loading: 'lazy' })),
    manage
      ? h('div', { class: 'photo-tools' },
          !inAlbum ? (i > 0 ? btn('Main', 'link', call(() => api(`/api/me/photos/${ph.id}/primary`, { body: {} }), 'Profile picture updated.')) : h('span', { class: 'muted small' }, 'Main')) : null,
          btn(inAlbum ? 'Public' : '🔒 Hide', 'link', call(() => api(`/api/me/photos/${ph.id}/visibility`, { body: { private: !inAlbum } }), inAlbum ? 'Moved to your public photos.' : 'Moved to your private album.')),
          btn('Delete', 'link', call(async () => { if (confirm('Delete this photo for good?')) await api(`/api/me/photos/${ph.id}`, { method: 'DELETE' }); })))
      : self ? null : btn('Report', 'link photo-report', () => void reportContent('photo', ph.id)))));

  const publicPane = h('div', { role: 'tabpanel' },
    p.photos.length ? photoGrid(p.photos, false) : h('p', { class: 'muted' }, 'No photos yet.'),
    manage ? h('button', { type: 'button', class: 'primary wide', onclick: (async () => { if ((await uploadPhotos(false)).length) reload(); }) as EventListener }, '+ Add photos') : null,
    manage ? h('p', { class: 'muted small' }, 'Any size, as many as you like. Location data is removed automatically, and photos copied from another member are refused.') : null);

  let albumPane: HTMLElement | null = null;
  // Your own album is managed on Edit profile; on your profile page you see what visitors see.
  if (p.canViewAlbum && (manage || !self)) {
    albumPane = h('div', { role: 'tabpanel', hidden: true }, h('p', { class: 'muted' }, 'Loading…'));
    const fillAlbum = async () => {
      const photos = await api<PhotoDTO[]>(`/api/profiles/${encodeURIComponent(p.handle)}/album`);
      const parts: (Node | null)[] = [
        h('p', { class: 'muted small' }, self
          ? 'Only you, friends you give access to below, and people you share a photo with in Messages can see these.'
          : `${p.handle} gave you access to their private album. Please keep it private.`),
        photos.length ? photoGrid(photos, true) : h('p', { class: 'muted' }, 'No private photos yet.'),
      ];
      if (manage) {
        parts.push(h('button', { type: 'button', class: 'primary wide', onclick: (async () => { if ((await uploadPhotos(true)).length) reload(); }) as EventListener }, '+ Add to private album'));
        const [access, friends] = await Promise.all([api<PublicUser[]>('/api/me/album-access'), api<FriendsDTO>('/api/friends')]);
        const has = new Set(access.map((a) => a.handle));
        const select = h('select', { 'aria-label': 'Friend to give access' },
          h('option', { value: '' }, 'Choose a friend…'),
          ...friends.friends.filter((f) => !has.has(f.handle)).map((f) => h('option', { value: f.handle }, f.handle)));
        parts.push(
          h('h3', {}, `Who can see my private album (${access.length})`),
          h('ul', { class: 'people' }, ...(access.length ? access.map((a) => h('li', {},
            h('a', { href: `/profile/${a.handle}`, class: 'person-link' }, avatar(a.avatar, a.handle, 'sm', a.quill), h('span', {}, a.handle)),
            btn('Remove', 'quiet', call(() => api(`/api/me/album-access/${a.handle}`, { method: 'DELETE' }), `${a.handle} can no longer see your private album.`))))
            : [h('li', { class: 'muted' }, 'Nobody yet.')])),
          friends.friends.length
            ? h('div', { class: 'row' }, select, btn('Give access', 'primary', call(async () => {
                if (!select.value) throw new Error('Choose a friend first.');
                await api(`/api/me/album-access/${select.value}`, { method: 'PUT', body: {} });
              }, 'Access given.')))
            : h('p', { class: 'muted small' }, 'Add friends first: album access is for friends only.'));
      }
      albumPane!.replaceChildren(...(parts.filter(Boolean) as Node[]));
    };
    void fillAlbum();
  }

  const tabBtn = (label: string, pane: HTMLElement, selected: boolean) => {
    const b = h('button', { type: 'button', role: 'tab', class: `tab${selected ? ' active' : ''}`, 'aria-selected': String(selected) }, label);
    b.addEventListener('click', () => {
      tabs.querySelectorAll('.tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      b.classList.add('active');
      b.setAttribute('aria-selected', 'true');
      publicPane.hidden = pane !== publicPane;
      if (albumPane) albumPane.hidden = pane !== albumPane;
    });
    return b;
  };
  const tabs = h('div', { class: 'tabs-row', role: 'tablist' },
    tabBtn(`Photos (${p.photos.length})`, publicPane, true),
    albumPane ? tabBtn(`🔒 Private album (${p.albumCount})`, albumPane, false) : null);
  return card(manage ? 'Photos' : null, tabs, publicPane, albumPane);
}
