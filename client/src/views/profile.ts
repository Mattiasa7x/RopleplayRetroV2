import { CHARACTER_SHEET, PROFILE, Trust } from '../../../shared/config.js';
import type { CommentDTO, FriendsDTO, PhotoDTO, ProfileDTO, PublicUser, StatusDTO } from '../../../shared/types.js';
import { avatar, card, page, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';
import { composer, reportContent } from './home.js';
import { lightbox, uploadPhotos } from './photos.js';

export async function viewProfile(handle: string) {
  page(handle, h('p', { class: 'muted' }, 'Loading…'));
  let p: ProfileDTO;
  try {
    p = await api<ProfileDTO>(`/api/profiles/${encodeURIComponent(handle)}`);
  } catch (e) {
    page('Not found', h('p', { class: 'notice' }, (e as Error).message));
    return;
  }
  const me = state.me!;
  const self = p.friendState === 'self';
  const reload = () => void viewProfile(p.handle);
  const call = (fn: () => Promise<unknown>, ok?: string) => async () => {
    try { await fn(); if (ok) toast(ok); reload(); } catch (e) { toast((e as Error).message, true); }
  };
  const btn = (label: string, cls: string, fn: () => void) => h('button', { type: 'button', class: cls, onclick: fn as EventListener }, label);

  // ----- header card -----
  const friendBtn = self ? null
    : p.blockedByMe ? null
    : p.friendState === 'friends' ? btn('Friends ✓', 'quiet', call(async () => { if (confirm(`Remove ${p.handle} from your friends?`)) await api(`/api/friends/${p.handle}`, { method: 'DELETE' }); }))
    : p.friendState === 'request_sent' ? btn('Request sent', 'quiet', call(() => api(`/api/friends/${p.handle}`, { method: 'DELETE' }), 'Request cancelled.'))
    : p.friendState === 'request_received' ? btn('Accept friend request', 'primary', call(() => api(`/api/friends/${p.handle}`, { body: {} }), 'You are now friends.'))
    : me.trust >= Trust.Verified ? btn('+ Add friend', 'primary', call(() => api(`/api/friends/${p.handle}`, { body: {} }), 'Friend request sent.'))
    : null;
  const blockBtn = self ? null : p.blockedByMe
    ? btn('Unblock', 'quiet', call(() => api(`/api/ignores/${p.handle}`, { method: 'DELETE' }), `${p.handle} is unblocked.`))
    : btn('Block', 'quiet', call(async () => {
        if (!confirm(`Block ${p.handle}? You won't see each other's messages, profiles or comments, and any friendship ends.`)) return;
        await api(`/api/ignores/${p.handle}`, { method: 'PUT', body: { mode: 'block' } });
      }, `${p.handle} is blocked.`));
  const reportBtn = self ? null : btn('Report', 'quiet', () => void reportContent('profile', undefined, p.handle));

  // ----- top: banner, picture, name, gold nameplate, "33, M, Hyrule" -----
  const charLine = [p.characterAge, p.characterGender, p.characterCity].filter((x) => x != null && x !== '').join(', ');
  const head = h('section', { class: 'profile-top' },
    h('div', { class: `profile-banner${p.banner ? '' : ' art-member'}` }, p.banner ? h('img', { src: p.banner, alt: '' }) : null),
    h('div', { class: 'profile-id' },
      avatar(p.avatar, p.handle, 'lg'),
      h('h1', { class: 'handle' }, p.handle),
      p.rpStyle ? h('span', { class: `nameplate${p.rpStyle === 'NSFW' ? ' adult' : ''}` }, p.rpStyle) : null,
      charLine ? h('p', { class: 'char-line' }, charLine) : null,
      h('p', { class: 'muted small' }, `${p.trustLabel} · ${p.friendCount} friend${p.friendCount === 1 ? '' : 's'}`),
      self ? null : h('div', { class: 'row wrap profile-actions' }, friendBtn,
        p.friendState === 'friends' ? h('a', { href: `/messages/${p.handle}`, class: 'button primary' }, 'Message') : null,
        blockBtn, reportBtn)),
    self ? h('a', { href: '/edit-profile', class: 'button primary edit-profile' }, 'Edit profile') : null);

  if (!p.visible) {
    page('Profile', head, card(null, h('p', { class: 'muted' },
      p.blockedByMe ? 'You have blocked this member.' : `${p.handle} shares their profile with friends only.`)));
    return;
  }

  // ----- about and character sheet (edited on the Edit profile page) -----
  const bioCard = p.bio ? card('About', h('p', { class: 'bio' }, p.bio)) : self ? card('About', h('p', { class: 'muted' }, 'Tell your story on the Edit profile page.')) : null;
  const sheetRows = CHARACTER_SHEET.filter((f) => p.characterSheet[f.key]);
  const sheetCard = sheetRows.length
    ? card('Character sheet', h('dl', { class: 'sheet-view' }, ...sheetRows.flatMap((f) => [
        h('dt', {}, f.label), h('dd', { class: 'long' in f ? 'long' : '' }, p.characterSheet[f.key]!)])))
    : null;

  // ----- photos: public photos and the private album, as two tabs -----
  const photoGrid = (photos: PhotoDTO[], inAlbum: boolean) => h('ul', { class: 'photo-grid' }, ...photos.map((ph, i) => h('li', {},
    h('button', { type: 'button', class: 'photo', 'aria-label': `Open photo ${i + 1}`, onclick: (() => lightbox(ph.url)) as EventListener },
      h('img', { src: ph.thumb, alt: '', loading: 'lazy' })),
    self
      ? h('div', { class: 'photo-tools' },
          !inAlbum ? (i > 0 ? btn('Main', 'link', call(() => api(`/api/me/photos/${ph.id}/primary`, { body: {} }), 'Profile picture updated.')) : h('span', { class: 'muted small' }, 'Main')) : null,
          inAlbum || !me.isMinor
            ? btn(inAlbum ? 'Public' : '🔒 Hide', 'link', call(() => api(`/api/me/photos/${ph.id}/visibility`, { body: { private: !inAlbum } }), inAlbum ? 'Moved to your public photos.' : 'Moved to your private album.'))
            : null,
          btn('Delete', 'link', call(async () => { if (confirm('Delete this photo for good?')) await api(`/api/me/photos/${ph.id}`, { method: 'DELETE' }); })))
      : btn('Report', 'link photo-report', () => void reportContent('photo', ph.id)))));

  const publicPane = h('div', { role: 'tabpanel' },
    p.photos.length ? photoGrid(p.photos, false) : h('p', { class: 'muted' }, 'No photos yet.'),
    self ? h('button', { type: 'button', class: 'primary wide', onclick: (async () => { if ((await uploadPhotos(false)).length) reload(); }) as EventListener }, '+ Add photos') : null,
    self ? h('p', { class: 'muted small' }, 'Any size, as many as you like. Location data is removed automatically, and photos copied from another member are refused.') : null);

  let albumPane: HTMLElement | null = null;
  if (p.canViewAlbum) {
    albumPane = h('div', { role: 'tabpanel', hidden: true }, h('p', { class: 'muted' }, 'Loading…'));
    const fillAlbum = async () => {
      const photos = await api<PhotoDTO[]>(`/api/profiles/${encodeURIComponent(p.handle)}/album`);
      const parts: (Node | null)[] = [
        h('p', { class: self && me.isMinor ? 'notice' : 'muted small' }, self
          ? me.isMinor
            ? 'Private albums are for members 18 and over. Only you can see these photos: make them public or delete them.'
            : 'Only you, friends you give access to below, and people you share a photo with in Messages can see these.'
          : `${p.handle} gave you access to their private album. Please keep it private.`),
        photos.length ? photoGrid(photos, true) : h('p', { class: 'muted' }, 'No private photos yet.'),
      ];
      if (self && !me.isMinor) {
        parts.push(h('button', { type: 'button', class: 'primary wide', onclick: (async () => { if ((await uploadPhotos(true)).length) reload(); }) as EventListener }, '+ Add to private album'));
        const [access, friends] = await Promise.all([api<PublicUser[]>('/api/me/album-access'), api<FriendsDTO>('/api/friends')]);
        const has = new Set(access.map((a) => a.handle));
        const select = h('select', { 'aria-label': 'Friend to give access' },
          h('option', { value: '' }, 'Choose a friend…'),
          ...friends.friends.filter((f) => !has.has(f.handle)).map((f) => h('option', { value: f.handle }, f.handle)));
        parts.push(
          h('h3', {}, `Who can see my private album (${access.length})`),
          h('ul', { class: 'people' }, ...(access.length ? access.map((a) => h('li', {},
            h('a', { href: `/profile/${a.handle}`, class: 'person-link' }, avatar(a.avatar, a.handle), h('span', {}, a.handle)),
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
  const photosCard = card(null, tabs, publicPane, albumPane);

  // ----- statuses -----
  const statuses = await api<StatusDTO[]>(`/api/profiles/${encodeURIComponent(p.handle)}/statuses`);
  const current = statuses[0];
  const statusCard = current
    ? card('Status', h('p', { class: 'my-status' }, current.body),
        self ? null : h('div', { class: 'post-meta' }, h('button', { type: 'button', class: 'link', onclick: (() => void reportContent('status', current.id)) as EventListener }, 'Report')))
    : null;

  // ----- comments -----
  const comments = await api<CommentDTO[]>(`/api/profiles/${encodeURIComponent(p.handle)}/comments`);
  const commentList = h('ul', { class: 'posts' }, ...comments.map((c) => {
    const li = h('li', { class: 'post' },
      h('a', { href: `/profile/${c.author.handle}`, class: 'post-head' }, avatar(c.author.avatar, c.author.handle), h('strong', {}, c.author.handle)),
      h('p', { class: 'post-body' }, c.body),
      h('div', { class: 'post-meta' }, h('span', { class: 'muted' }, timeAgo(c.createdAt)),
        c.canDelete ? btn('Delete', 'link', async () => {
          if (!confirm('Delete this comment?')) return;
          try { await api(`/api/comments/${c.id}`, { method: 'DELETE' }); li.remove(); } catch (e) { toast((e as Error).message, true); }
        }) : null,
        c.author.id !== me.id ? btn('Report', 'link', () => void reportContent('comment', c.id)) : null));
    return li;
  }));
  if (!comments.length) commentList.append(h('li', { class: 'muted empty' }, 'No comments yet.'));
  const commentBox = p.canComment
    ? composer(self ? 'Write on your own profile…' : `Write something to ${p.handle}…`, PROFILE.commentMax, 'Comment', async (body) => {
        await api(`/api/profiles/${encodeURIComponent(p.handle)}/comments`, { body: { body } });
        reload();
      })
    : h('p', { class: 'muted small' }, self ? '' : `${p.handle} isn't taking comments from you.`);

  page('Profile', head, statusCard, bioCard, sheetCard, photosCard, card('Comments', commentBox, commentList));
  if (location.pathname !== `/profile/${p.handle}`) history.replaceState({}, '', `/profile/${p.handle}`);
}
