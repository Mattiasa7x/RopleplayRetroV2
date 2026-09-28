import { CHARACTER_SHEET, PROFILE, Trust } from '../../../shared/config.js';
import type { CommentDTO, ProfileDTO, StatusDTO } from '../../../shared/types.js';
import { avatar, card, page, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';
import { composer, reportContent } from './home.js';
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

  // ----- about and character sheet (edited on the Edit profile page) -----
  const bioCard = p.bio ? card('About', h('p', { class: 'bio' }, p.bio)) : self ? card('About', h('p', { class: 'muted' }, 'Tell your story on the Edit profile page.')) : null;
  const sheetRows = CHARACTER_SHEET.filter((f) => p.characterSheet[f.key]);
  const sheetCard = sheetRows.length
    ? card('Character sheet', h('dl', { class: 'sheet-view' }, ...sheetRows.flatMap((f) => [
        h('dt', {}, f.label), h('dd', { class: 'long' in f ? 'long' : '' }, p.characterSheet[f.key]!)])))
    : null;

  // ----- photos (read-only here; managed on Edit profile > Photos) -----
  const photosCard = await photoSection(p, { manage: false, reload });

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
