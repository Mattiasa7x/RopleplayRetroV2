import { meIsQuill } from './quill.js';
import { CHARACTER_SHEET, PROFILE, Trust } from '../../../shared/config.js';
import type { PhotoPageDTO, ProfileDTO, ProfileFriendsDTO, ProfileViewsDTO, StatusDTO } from '../../../shared/types.js';
import { person } from './friends.js';
import { giftName, giftTile } from '../giftart.js';
import { avatar, card, navigate, page, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';
import { commentThread } from './comments.js';
import { reportContent } from './home.js';
import { lightbox } from './photos.js';
import { photoSection } from './photosection.js';
import { trophyBadge } from '../trophyart.js';
import { TROPHY_BY_ID } from '../../../shared/trophies.js';

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
        if (!confirm(`Block ${p.handle}? You won't see each other anywhere, and any friendship ends.`)) return;
        await api(`/api/ignores/${p.handle}`, { method: 'PUT', body: { mode: 'block' } });
      }, `${p.handle} is blocked.`));
  const reportBtn = self ? null : btn('Report', 'quiet', () => void reportContent('profile', undefined, p.handle));

  // ----- top: banner, picture, name, gold nameplate, "33, M, Hyrule" -----
  const charLine = [p.characterAge, p.characterGender, p.characterCity].filter((x) => x != null && x !== '').join(', ');
  // "3 friends" opens the friends list when the owner allows it; "Views" is only ever on your own profile.
  const friendsText = `${p.friendCount} friend${p.friendCount === 1 ? '' : 's'}`;
  const friendsBit = p.canViewFriends ? h('a', { href: `/profile/${p.handle}/friends` }, friendsText) : h('span', {}, friendsText);
  const viewsText = `${p.viewCount ?? 0} view${p.viewCount === 1 ? '' : 's'}`;
  // Others see the count only; who viewed is always private.
  const viewsLink = !self
    ? (p.viewCount !== undefined ? h('span', {}, viewsText) : null)
    : h('a', { href: meIsQuill() ? '/profile-views' : '/gold-quill?from=views', class: 'views-link' }, viewsText, meIsQuill() ? null : h('span', { class: 'quill-lock', 'aria-label': 'Gold Quill' }, '🪶'), p.newViews ? h('span', { class: 'badge views-new', 'aria-label': `${p.newViews} new` }, String(p.newViews)) : null);
  // Your own gifts, or "Send a gift" on someone else's profile.
  const giftsText = `${p.giftCount ?? 0} gift${p.giftCount === 1 ? '' : 's'}`;
  const giftLink = self
    ? h('a', { href: '/gifts' }, giftsText)
    : p.canSendGift ? h('a', { href: `/profile/${p.handle}/gift` }, 'Send a gift') : null;
  // Someone else's gift count: always shown; a link only when they share their gifts.
  const theirGifts = self || p.giftCount === undefined ? null
    : p.canViewGifts ? h('a', { href: `/profile/${p.handle}/gifts` }, giftsText) : h('span', {}, giftsText);
  const head = h('section', { class: 'profile-top' },
    h('div', { class: `profile-banner${p.banner ? '' : ' art-member'}` }, p.banner ? h('img', { src: p.banner, alt: '' }) : null),
    h('div', { class: 'profile-id' },
      avatar(p.avatar, p.handle, 'lg', p.quill),
      h('h1', { class: 'handle' }, p.handle),
      p.rpStyle || self
        ? h('div', { class: 'nameplate-row' },
            p.rpStyle ? h('span', { class: `nameplate${p.rpStyle === 'NSFW' ? ' adult' : ''}` }, p.rpStyle) : h('span', {}),
            self ? h('a', { href: '/edit-profile', class: 'button primary edit-profile' }, 'Edit profile') : null)
        : null,
      charLine ? h('p', { class: 'char-line' }, charLine) : null,
      h('p', { class: 'profile-meta muted small' }, `${p.trustLabel} · `, friendsBit, viewsLink ? ' · ' : null, viewsLink,
        theirGifts ? ' · ' : null, theirGifts, giftLink ? ' · ' : null, giftLink),
      h('div', { class: 'showcase-row' }, profileTrophy(p, self), profileGiftPill(p, self)),
      self ? null : h('div', { class: 'row wrap profile-actions' }, friendBtn,
        p.friendState === 'friends' ? h('a', { href: `/messages/${p.handle}`, class: 'button primary' }, 'Message') : null,
        blockBtn, reportBtn)));

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
  const bioCard = p.bio ? card(null, h('p', { class: 'bio' }, p.bio)) : self ? card(null, h('p', { class: 'muted' }, 'Add one in Edit profile.')) : null;
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
  // Background theme: the chosen room picture behind the whole profile.
  if (p.theme) {
    const main = document.getElementById('main')!;
    main.classList.add('themed');
    main.prepend(h('div', { class: 'profile-bg', 'aria-hidden': 'true' }, h('img', { src: p.theme.image, alt: '' })));
  }
  if (location.pathname !== `/profile/${p.handle}`) history.replaceState({}, '', `/profile/${p.handle}`);
}

/** The one trophy the member chose to show; tapping it opens everything they've earned. */
function profileTrophy(p: ProfileDTO, self: boolean): HTMLElement | null {
  if (!p.visible) return null;
  const href = `/profile/${p.handle}/trophies`;
  if (!p.trophy) {
    if (!self) return null;
    return h('a', { href, class: 'profile-trophy empty' }, p.trophyCount ? '🏆 My trophies' : '🏆 Trophies you can earn');
  }
  const name = TROPHY_BY_ID.get(p.trophy)?.name ?? '';
  const others = p.trophyCount - 1;
  return h('a', { href, class: 'profile-trophy', 'aria-label': `${name} trophy. See all ${p.trophyCount} of ${p.handle}'s trophies.` },
    trophyBadge(p.trophy, { size: 40 }),
    h('span', { class: 'profile-trophy-text' },
      h('strong', {}, name),
      h('span', { class: 'muted small' }, others > 0 ? `+${others} more` : 'Trophy')));
}

/** The gift a member chose to show (never its message or sender), beside their trophy. */
function profileGiftPill(p: ProfileDTO, self: boolean): HTMLElement | null {
  if (!p.profileGift) return null;
  return h('a', { href: self ? '/gifts' : `/profile/${p.handle}/gifts`, class: 'profile-trophy profile-gift', 'aria-label': `Favourite gift: ${giftName(p.profileGift)}. See ${self ? 'your' : `${p.handle}'s`} gifts.` },
    giftTile(p.profileGift, 'sm'),
    h('span', { class: 'profile-trophy-text' }, h('strong', {}, giftName(p.profileGift)), h('span', { class: 'muted small' }, 'Favourite gift')));
}

/** A member's friends, if they let you see the list. */
export async function viewProfileFriends(handle: string) {
  page('Friends', h('p', { class: 'muted' }, 'Loading…'));
  const d = await api<ProfileFriendsDTO>(`/api/profiles/${encodeURIComponent(handle)}/friends`);
  const back = h('a', { href: `/profile/${d.handle}`, class: 'back' }, `‹ ${d.handle}`);
  if (!d.allowed) {
    page('Friends', back, card(null, h('p', { class: 'muted' }, `${d.handle} keeps their friends list private.`)));
    return;
  }
  page('Friends', back,
    card(`${d.handle}'s friends (${d.friends.length})`,
      d.friends.length ? h('ul', { class: 'people' }, ...d.friends.map((f) => person(f))) : h('p', { class: 'muted' }, 'No friends yet.')));
}

/** Who viewed your profile and when: only ever your own. */
export async function viewProfileViews(pageNo = 1) {
  if (!meIsQuill()) return navigate('/gold-quill?from=views', true);
  page('Profile views', h('p', { class: 'muted' }, 'Loading…'));
  let d: ProfileViewsDTO;
  try { d = await api<ProfileViewsDTO>(`/api/me/profile-views?page=${pageNo}`); }
  catch (e) { if ((e as { code?: string }).code === 'quill_required') return navigate('/gold-quill?from=views', true); throw e; }
  const me = state.me!;
  const when = (iso: string) => {
    const t = new Date(iso);
    const today = new Date().toDateString() === t.toDateString();
    return today ? `Today ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : t.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const list = d.views.length
    ? h('ul', { class: 'people views-list' }, ...d.views.map((v) =>
        person(v.user, h('span', { class: 'muted small view-time', title: new Date(v.viewedAt).toLocaleString() },
          Date.now() - Date.parse(v.viewedAt) < 864e5 ? timeAgo(v.viewedAt) : null, h('span', { class: 'block' }, when(v.viewedAt))))))
    : h('p', { class: 'muted' }, 'Nobody has viewed your profile in the last 90 days.');
  const pager = d.pages > 1
    ? h('div', { class: 'pager' },
        h('button', { type: 'button', class: 'quiet', disabled: d.page <= 1, onclick: (() => void viewProfileViews(d.page - 1)) as EventListener }, '‹ Newer'),
        h('span', { class: 'muted small' }, `Page ${d.page} of ${d.pages}`),
        h('button', { type: 'button', class: 'quiet', disabled: d.page >= d.pages, onclick: (() => void viewProfileViews(d.page + 1)) as EventListener }, 'Older ›'))
    : null;
  page('Profile views',
    h('a', { href: `/profile/${me.handle}`, class: 'back' }, `‹ ${me.handle}`),
    card(`Who viewed your profile (${d.total})`,
      h('p', { class: 'muted small' }, 'Only you see this. Latest visit per person, last 90 days.'),
      list, pager));
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
        h('a', { href: `/profile/${d.owner.handle}`, class: 'post-head' }, avatar(d.owner.avatar, d.owner.handle, 'sm', d.owner.quill), h('strong', {}, d.owner.handle)),
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
