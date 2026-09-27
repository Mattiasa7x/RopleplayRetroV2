import { PROFILE, Trust } from '../../../shared/config.js';
import { cleanBody, visibleLength } from '../../../shared/text.js';
import type { HomeDTO, StatusDTO } from '../../../shared/types.js';
import { avatar, card, page, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';

/** One status update, used on Home and on profiles. */
export function statusItem(s: StatusDTO, onRemoved: () => void): HTMLElement {
  const li = h('li', { class: 'post' },
    h('a', { href: `/profile/${s.author.handle}`, class: 'post-head' }, avatar(s.author.avatar, s.author.handle), h('strong', {}, s.author.handle)),
    h('p', { class: 'post-body' }, s.body),
    h('div', { class: 'post-meta' },
      h('span', { class: 'muted' }, timeAgo(s.createdAt)),
      s.canDelete
        ? h('button', { type: 'button', class: 'link', onclick: (async () => {
            if (!confirm('Delete this status?')) return;
            try { await api(`/api/statuses/${s.id}`, { method: 'DELETE' }); li.remove(); onRemoved(); } catch (e) { toast((e as Error).message, true); }
          }) as EventListener }, 'Delete')
        : s.author.id !== state.me?.id
          ? h('button', { type: 'button', class: 'link', onclick: (() => void reportContent('status', s.id)) as EventListener }, 'Report')
          : null));
  return li;
}

export async function reportContent(kind: 'status' | 'comment' | 'photo' | 'profile', id?: string, handle?: string) {
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

export async function viewHome() {
  page('Home', h('p', { class: 'muted' }, 'Loading…'));
  let data: HomeDTO = await api<HomeDTO>('/api/home');
  state.friendRequests = data.pendingRequests;
  const me = state.me!;

  const feed = h('ul', { class: 'posts' });
  const empty = h('li', { class: 'muted empty' }, 'Nothing here yet. Post a status or add some friends.');
  const moreBtn = h('button', { type: 'button', class: 'quiet wide' }, 'Show older');
  const fill = (items: StatusDTO[]) => {
    for (const s of items) feed.append(statusItem(s, () => {}));
    if (!feed.children.length) feed.append(empty);
    moreBtn.hidden = !data.olderCursor;
  };
  moreBtn.addEventListener('click', async () => {
    data = await api<HomeDTO>(`/api/home?before=${data.olderCursor}`);
    fill(data.feed);
  });
  fill(data.feed);

  const post = me.trust >= Trust.Verified
    ? composer("What's your status?", PROFILE.statusMax, 'Post', async (body) => {
        await api('/api/statuses', { body: { body } });
        const fresh = await api<HomeDTO>('/api/home');
        data = fresh;
        feed.replaceChildren();
        fill(fresh.feed);
      })
    : h('p', { class: 'notice' }, 'Confirm your email to post status updates. ', h('a', { href: '/verify' }, 'Enter code'));

  const favs = data.favorites.length
    ? h('ul', { class: 'chips' }, ...data.favorites.map((r) =>
        h('li', {}, h('a', { href: `/room/${r.slug}`, class: 'chip' }, '★ ', r.name, h('span', { class: 'count' }, ` ${r.online}`)))))
    : h('p', { class: 'muted' }, 'Tap ☆ in any room to pin it here. ', h('a', { href: '/rooms' }, 'Browse rooms'));

  page('Home',
    !me.emailVerified ? h('p', { class: 'notice' }, 'Confirm your email to unlock every room, member rooms and posting. ', h('a', { href: '/verify' }, 'Enter code')) : null,
    data.pendingRequests ? h('p', { class: 'notice' }, h('a', { href: '/friends' }, `You have ${data.pendingRequests} friend request${data.pendingRequests === 1 ? '' : 's'}`)) : null,
    card('Status', post),
    card('Favorite rooms', favs),
    card('Friends feed', feed, moreBtn));
}
