import { PROFILE, Trust } from '../../../shared/config.js';
import type { CommentDTO, ProfileDTO, StatusDTO } from '../../../shared/types.js';
import { avatar, card, page, state, timeAgo, toast } from '../core.js';
import { api, apiUpload, h } from '../dom.js';
import { composer, reportContent, statusItem } from './home.js';

function lightbox(url: string) {
  const d = h('dialog', { class: 'lightbox' },
    h('img', { src: url, alt: 'Photo' }),
    h('button', { type: 'button', class: 'primary', onclick: (() => d.close()) as EventListener }, 'Close'));
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  document.body.append(d);
  d.showModal();
}

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

  const head = h('section', { class: 'card profile-head' },
    avatar(p.avatar, p.handle, 'lg'),
    h('div', {},
      h('h1', { class: 'handle' }, p.handle),
      h('p', { class: 'muted small' }, `${p.trustLabel} · joined ${new Date(p.joined).toLocaleDateString()} · ${p.friendCount} friend${p.friendCount === 1 ? '' : 's'}`),
      h('div', { class: 'row wrap' }, friendBtn, self ? h('a', { href: '/settings', class: 'button quiet' }, 'Settings') : null, blockBtn, reportBtn)));

  if (!p.visible) {
    page(p.handle, head, card(null, h('p', { class: 'muted' },
      p.blockedByMe ? 'You have blocked this member.' : `${p.handle} shares their profile with friends only.`)));
    return;
  }

  // ----- bio -----
  let bioCard: HTMLElement;
  if (self) {
    const ta = h('textarea', { rows: 4, maxlength: PROFILE.bioMax, placeholder: 'Tell people about you and your characters…', 'aria-label': 'Bio' });
    ta.value = p.bio ?? '';
    const count = h('span', { class: 'counter' }, `${PROFILE.bioMax - ta.value.length} left`);
    ta.addEventListener('input', () => { count.textContent = `${PROFILE.bioMax - ta.value.length} left`; });
    bioCard = card('About me', ta, h('div', { class: 'row' }, count,
      btn('Save bio', 'primary', call(() => api('/api/me/profile', { method: 'PATCH', body: { bio: ta.value } }), 'Bio saved.'))));
  } else {
    bioCard = card('About', h('p', { class: 'bio' }, p.bio ?? 'No bio yet.'));
  }

  // ----- photos -----
  const grid = h('ul', { class: 'photo-grid' }, ...p.photos.map((ph, i) => h('li', {},
    h('button', { type: 'button', class: 'photo', 'aria-label': `Open photo ${i + 1}`, onclick: (() => lightbox(ph.url)) as EventListener },
      h('img', { src: ph.url, alt: '', loading: 'lazy' })),
    self ? h('div', { class: 'photo-tools' },
      i > 0 ? btn('Main', 'link', call(() => api(`/api/me/photos/${ph.id}/primary`, { body: {} }), 'Profile picture updated.')) : h('span', { class: 'muted small' }, 'Main'),
      btn('Delete', 'link', call(async () => { if (confirm('Delete this photo?')) await api(`/api/me/photos/${ph.id}`, { method: 'DELETE' }); })))
      : btn('Report', 'link photo-report', () => void reportContent('photo', ph.id)))));
  let uploader: HTMLElement | null = null;
  if (self && p.photos.length < PROFILE.maxPhotos) {
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'visually-hidden', id: 'photo-file' });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      if (f.size > PROFILE.photoMaxBytes) return toast('That photo is too large (5 MB max).', true);
      toast('Uploading…');
      try { await apiUpload('/api/me/photos', f); toast('Photo added.'); reload(); } catch (e) { toast((e as Error).message, true); }
    });
    uploader = h('div', {}, file, h('label', { for: 'photo-file', class: 'button primary wide' }, '+ Add a photo'),
      h('p', { class: 'muted small' }, `Up to ${PROFILE.maxPhotos} photos. Location data is removed automatically. Photos copied from another member are refused.`));
  }
  const photosCard = card(`Photos (${p.photos.length})`, p.photos.length ? grid : h('p', { class: 'muted' }, 'No photos yet.'), uploader);

  // ----- statuses -----
  const statuses = await api<StatusDTO[]>(`/api/profiles/${encodeURIComponent(p.handle)}/statuses`);
  const statusCard = statuses.length ? card('Recent statuses', h('ul', { class: 'posts' }, ...statuses.map((s) => statusItem(s, () => {})))) : null;

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

  page(p.handle, head, bioCard, photosCard, statusCard, card('Comments', commentBox, commentList));
  if (location.pathname !== `/profile/${p.handle}`) history.replaceState({}, '', `/profile/${p.handle}`);
}
