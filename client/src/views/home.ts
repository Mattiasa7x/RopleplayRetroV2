import { PROFILE, Trust } from '../../../shared/config.js';
import { cleanBody, visibleLength } from '../../../shared/text.js';
import type { ActivityDTO, HomeDTO, StatusDTO } from '../../../shared/types.js';
import { avatar, card, page, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';
import { lightbox } from './photos.js';
import { onlineCard } from './online.js';
import { roomTile } from './rooms.js';

export async function reportContent(kind: 'status' | 'comment' | 'photo' | 'profile' | 'dm' | 'photo_comment' | 'gift', id?: string, handle?: string) {
  const reason = prompt('What is wrong with it? (sent privately to the moderators)');
  if (!reason?.trim()) return;
  try {
    await api('/api/reports/content', { body: { kind, id, handle, reason: reason.trim() } });
    toast('Report sent. Thank you.');
  } catch (e) {
    toast((e as Error).message, true);
  }
}

/** Text box with a live "N left" counter. */
export function composer(placeholder: string, max: number, submitLabel: string, onSend: (body: string) => Promise<void>): HTMLFormElement {
  const ta = h('textarea', { rows: 2, placeholder, 'aria-label': placeholder, maxlength: max * 4 });
  const counter = h('span', { class: 'counter' });
  const btn = h('button', { type: 'submit', class: 'primary' }, submitLabel);
  const update = () => {
    const left = max - visibleLength(cleanBody(ta.value));
    counter.textContent = `${left} left`;
    counter.className = 'counter' + (left < 0 ? ' over' : left <= 40 ? ' warn' : '');
    btn.disabled = left < 0 || left === max;
  };
  const f = h('form', { class: 'composer-box' }, ta, h('div', { class: 'row' }, counter, btn));
  ta.addEventListener('input', update);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await onSend(ta.value);
      ta.value = '';
    } catch (x) {
      toast((x as Error).message, true);
    }
    update();
  });
  update();
  return f;
}

/** One line of friend activity. */
function activityItem(a: ActivityDTO): HTMLElement {
  const who = h('a', { href: `/profile/${a.actor.handle}`, class: 'post-head' }, avatar(a.actor.avatar, a.actor.handle, 'sm', a.actor.quill), h('strong', {}, a.actor.handle));
  const when = h('span', { class: 'muted' }, timeAgo(a.at));
  switch (a.kind) {
    case 'status':
      return h('li', { class: 'post' }, who,
        h('p', { class: 'post-kind muted small' }, 'posted a status'),
        h('p', { class: 'post-body' }, a.body),
        h('div', { class: 'post-meta' }, when,
          h('button', { type: 'button', class: 'link', onclick: (() => void reportContent('status', a.statusId)) as EventListener }, 'Report')));
    case 'comment':
      return h('li', { class: 'post' }, who,
        h('p', { class: 'post-kind muted small' }, a.onMe ? 'commented on your profile' : 'commented on ',
          a.onMe ? null : h('a', { href: `/profile/${a.target.handle}` }, `${a.target.handle}'s profile`)),
        h('p', { class: 'post-body quote' }, a.body),
        h('div', { class: 'post-meta' }, when,
          h('button', { type: 'button', class: 'link', onclick: (() => void reportContent('comment', a.commentId)) as EventListener }, 'Report')));
    case 'photos':
      return h('li', { class: 'post' }, who,
        h('p', { class: 'post-kind muted small' }, a.count === 1 ? 'added a new photo' : `added ${a.count} new photos`),
        h('ul', { class: 'photo-grid feed-photos' }, ...a.photos.map((ph) => h('li', {},
          h('button', { type: 'button', class: 'photo', 'aria-label': 'Open photo', onclick: (() => lightbox(ph.url)) as EventListener },
            h('img', { src: ph.thumb, alt: '', loading: 'lazy' }))))),
        h('div', { class: 'post-meta' }, when));
    case 'profile':
      return h('li', { class: 'post' }, who,
        h('p', { class: 'post-kind muted small' }, 'updated their profile · ', h('a', { href: `/profile/${a.actor.handle}` }, 'Have a look')),
        h('div', { class: 'post-meta' }, when));
  }
}

export async function viewHome() {
  page('Home', h('p', { class: 'muted' }, 'Loading…'));
  let data: HomeDTO = await api<HomeDTO>('/api/home');
  state.friendRequests = data.pendingRequests;
  const me = state.me!;

  // 1. Your status: just the words. Posting a new one replaces it.
  const latest = h('p', { class: 'my-status' });
  const paintLatest = (st: StatusDTO | null) => {
    latest.textContent = st ? st.body : "You haven't posted a status yet.";
    latest.classList.toggle('muted', !st);
  };
  paintLatest(data.myStatus);
  const post = me.trust >= Trust.Verified
    ? composer('Post a new status…', PROFILE.statusMax, 'Update', async (body) => {
        const d = new Date(); // your own calendar day, for the status streak
        const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        await api('/api/statuses', { body: { body, localDate } });
        paintLatest((await api<HomeDTO>('/api/home')).myStatus);
      })
    : h('p', { class: 'notice' }, 'Confirm your email to post status updates. ', h('a', { href: '/verify' }, 'Enter code'));

  // 2. What your friends have been doing (never your own posts).
  const feed = h('ul', { class: 'posts' });
  const moreBtn = h('button', { type: 'button', class: 'quiet wide' }, 'Show older');
  const fill = (items: ActivityDTO[]) => {
    for (const a of items) feed.append(activityItem(a));
    if (!feed.children.length) {
      feed.append(h('li', { class: 'muted empty' }, 'No friend activity yet. ', h('a', { href: '/friends' }, 'Find friends'), ' and their statuses, comments, new photos and profile updates will show up here.'));
    }
    moreBtn.hidden = !data.olderCursor;
  };
  moreBtn.addEventListener('click', async () => {
    moreBtn.disabled = true;
    try {
      data = await api<HomeDTO>(`/api/home?before=${encodeURIComponent(data.olderCursor!)}`);
      fill(data.feed);
    } catch (e) { toast((e as Error).message, true); }
    moreBtn.disabled = false;
  });
  fill(data.feed);

  // 3. The six busiest rooms.
  const top = data.topRooms.length
    ? h('ul', { class: 'room-tiles' }, ...data.topRooms.map((r) => roomTile(r)))
    : h('p', { class: 'muted' }, h('a', { href: '/rooms' }, 'Browse rooms'));

  page('Home',
    !me.emailVerified ? h('p', { class: 'notice' }, 'Confirm your email to unlock every room, member rooms and posting. ', h('a', { href: '/verify' }, 'Enter code')) : null,
    data.pendingRequests ? h('p', { class: 'notice' }, h('a', { href: '/friends' }, `You have ${data.pendingRequests} friend request${data.pendingRequests === 1 ? '' : 's'}`)) : null,
    card('Your status', latest, post),
    card('Friend activity', feed, moreBtn),
    await onlineCard(),
    card('Busiest rooms', top, h('a', { href: '/rooms', class: 'button quiet wide' }, 'All rooms')));
}
