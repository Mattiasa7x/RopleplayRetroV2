import { CHARACTER_SHEET, PROFILE, Trust } from '../../../shared/config.js';
import type { PhotoPageDTO, ProfileDTO, StatusDTO } from '../../../shared/types.js';
import { avatar, card, page, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';
import { commentThread } from './comments.js';
import { reportContent } from './home.js';
import { lightbox } from './photos.js';
import { photoSection } from './photosection.js';

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

  // ----- newest photos, then a small button to the full gallery -----
  const recent = [...p.photos].sort((x, y) => (BigInt(y.id) > BigInt(x.id) ? 1 : -1)).slice(0, PROFILE.recentPhotos);
  const photoStrip = recent.length || p.canViewAlbum
    ? h('section', { class: 'recent-photos', 'aria-label': 'Newest photos' },
        recent.length ? h('ul', { class: 'photo-strip' }, ...recent.map((ph, i) =>
          h('li', {}, h('a', { href: `/photo/${ph.id}`, class: 'photo', 'aria-label': `Photo ${i + 1}` }, h('img', { src: ph.thumb, alt: '', loading: 'lazy' }))))) : null,
        h('a', { href: `/profile/${p.handle}/photos`, class: 'button quiet small-btn' }, `Photo gallery (${p.photos.length})`))
    : null;

  // ----- status: just the words -----
  const statuses = await api<StatusDTO[]>(`/api/profiles/${encodeURIComponent(p.handle)}/statuses`);
  const statusLine = statuses[0] ? h('p', { class: 'profile-status' }, statuses[0].body) : null;

  // ----- the story (no heading), then the character sheet -----
  const bioCard = p.bio ? card(null, h('p', { class: 'bio' }, p.bio)) : self ? card(null, h('p', { class: 'muted' }, 'Tell your story on the Edit profile page.')) : null;
  const sheetRows = CHARACTER_SHEET.filter((f) => p.characterSheet[f.key]);
  const sheetCard = sheetRows.length
    ? card('Character sheet', h('dl', { class: 'sheet-view' }, ...sheetRows.flatMap((f) => [
        h('dt', {}, f.label), h('dd', { class: 'long' in f ? 'long' : '' }, p.characterSheet[f.key]!)])))
    : null;

  // ----- comments: newest 5 here, the rest 10 at a time on their own page -----
  const comments = commentThread({
    url: `/api/profiles/${encodeURIComponent(p.handle)}/comments`,
    deleteUrl: (id) => `/api/comments/${id}`,
    reportKind: 'comment',
    canComment: p.canComment,
    placeholder: self ? 'Write on your own profile…' : `Write something to ${p.handle}…`,
    preview: { size: PROFILE.commentsOnProfile, moreHref: `/profile/${p.handle}/comments` },
  });

  page('Profile', head, photoStrip, statusLine, bioCard, sheetCard, comments);
  if (location.pathname !== `/profile/${p.handle}`) history.replaceState({}, '', `/profile/${p.handle}`);
}

/** Every photo on a profile (and the private album, for those allowed), each opening its own page. */
export async function viewGallery(handle: string) {
  page('Photos', h('p', { class: 'muted' }, 'Loading…'));
  const p = await api<ProfileDTO>(`/api/profiles/${encodeURIComponent(handle)}`);
  const self = p.friendState === 'self';
  page('Photos',
    h('a', { href: `/profile/${p.handle}`, class: 'back' }, `‹ ${p.handle}`),
    p.visible ? await photoSection(p, { manage: false, reload: () => void viewGallery(handle) }) : card(null, h('p', { class: 'muted' }, `${p.handle} shares their profile with friends only.`)),
    self ? h('a', { href: '/edit-profile?tab=photos', class: 'button quiet small-btn center-btn' }, 'Manage photos') : null);
}

/** All comments on a profile, 10 at a time. */
export async function viewProfileComments(handle: string) {
  page('Comments', h('p', { class: 'muted' }, 'Loading…'));
  const p = await api<ProfileDTO>(`/api/profiles/${encodeURIComponent(handle)}`);
  const self = p.friendState === 'self';
  page('Comments',
    h('a', { href: `/profile/${p.handle}`, class: 'back' }, `‹ ${p.handle}`),
    p.visible
      ? commentThread({
          url: `/api/profiles/${encodeURIComponent(p.handle)}/comments`,
          deleteUrl: (id) => `/api/comments/${id}`,
          reportKind: 'comment',
          canComment: p.canComment,
          placeholder: self ? 'Write on your own profile…' : `Write something to ${p.handle}…`,
        })
      : card(null, h('p', { class: 'muted' }, `${p.handle} shares their profile with friends only.`)));
}

/** One photo, big, with its comments underneath. */
export async function viewPhoto(id: string) {
  page('Photo', h('p', { class: 'muted' }, 'Loading…'));
  let d: PhotoPageDTO;
  try {
    d = await api<PhotoPageDTO>(`/api/photos/${encodeURIComponent(id)}`);
  } catch (e) {
    page('Photo', h('p', { class: 'notice' }, (e as Error).message));
    return;
  }
  page('Photo',
    h('a', { href: `/profile/${d.owner.handle}/photos`, class: 'back' }, `‹ ${d.owner.handle}'s photos`),
    h('figure', { class: 'photo-view' },
      h('button', { type: 'button', class: 'photo-full', 'aria-label': 'View full screen', onclick: (() => lightbox(d.photo.url)) as EventListener },
        h('img', { src: d.photo.url, alt: `Photo by ${d.owner.handle}` })),
      h('figcaption', { class: 'row' },
        h('a', { href: `/profile/${d.owner.handle}`, class: 'post-head' }, avatar(d.owner.avatar, d.owner.handle), h('strong', {}, d.owner.handle)),
        d.photo.private ? h('span', { class: 'tag' }, 'Private') : null,
        d.mine ? null : h('button', { type: 'button', class: 'link', onclick: (() => void reportContent('photo', d.photo.id)) as EventListener }, 'Report'))),
    commentThread({
      url: `/api/photos/${encodeURIComponent(d.photo.id)}/comments`,
      deleteUrl: (cid) => `/api/photo-comments/${cid}`,
      reportKind: 'photo_comment',
      canComment: d.canComment,
      placeholder: 'Say something about this photo…',
    }));
}
