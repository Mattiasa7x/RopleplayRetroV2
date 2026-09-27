import { CHAT } from '../../../shared/config.js';
import { cleanBody, visibleLength } from '../../../shared/text.js';
import type { ConversationDTO, DirectMessageDTO, PhotoDTO, ThreadDTO } from '../../../shared/types.js';
import { avatar, card, navigate, page, refreshUnread, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';
import { reportContent } from './home.js';
import { lightbox, uploadPhotos } from './photos.js';

export async function viewInbox() {
  page('Messages', h('p', { class: 'muted' }, 'Loading…'));
  const list = await api<ConversationDTO[]>('/api/messages');
  void refreshUnread();
  page('Messages',
    card(null,
      list.length
        ? h('ul', { class: 'people inbox' }, ...list.map((c) => h('li', { class: c.unread ? 'unread' : '' },
            h('a', { href: `/messages/${c.with.handle}`, class: 'person-link' },
              avatar(c.with.avatar, c.with.handle, 'md'),
              h('span', { class: 'inbox-text' },
                h('strong', {}, c.with.handle),
                h('span', { class: 'muted small block preview' }, (c.lastFromMe ? 'You: ' : '') + c.preview))),
            h('span', { class: 'inbox-meta' },
              h('span', { class: 'muted small' }, timeAgo(c.lastAt)),
              c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null))))
        : h('p', { class: 'muted' }, 'No messages yet. You can message any friend from their profile or your friends list.')),
    h('a', { href: '/friends', class: 'button quiet wide' }, 'Start a conversation from Friends'));
}

function bubble(m: DirectMessageDTO, other: string, onRemoved: () => void): HTMLElement {
  void other;
  const li = h('li', { class: `bubble ${m.mine ? 'mine' : 'theirs'}` },
    m.photo
      ? h('button', { type: 'button', class: 'bubble-photo', 'aria-label': 'Open photo', onclick: (() => lightbox(m.photo!.url)) as EventListener },
          h('img', { src: m.photo.thumb, alt: 'Shared photo', loading: 'lazy' }),
          m.photo.private ? h('span', { class: 'lock-tag' }, '🔒 private') : null)
      : m.photoRemoved ? h('p', { class: 'muted small' }, 'Photo no longer available') : null,
    m.body ? h('p', { class: 'bubble-text' }, m.body) : null,
    h('span', { class: 'bubble-meta muted' }, timeAgo(m.createdAt), m.mine && m.read ? ' · Seen' : ''));
  li.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.bubble-photo')) return;
    li.querySelector('.bubble-tools')?.remove();
    li.append(h('span', { class: 'bubble-tools' },
      h('button', { type: 'button', class: 'link', onclick: (async (ev: Event) => {
        ev.stopPropagation();
        await api(`/api/messages/item/${m.id}`, { method: 'DELETE' });
        li.remove();
        onRemoved();
      }) as EventListener }, 'Delete for me'),
      !m.mine ? h('button', { type: 'button', class: 'link', onclick: ((ev: Event) => { ev.stopPropagation(); void reportContent('dm', m.id); }) as EventListener }, 'Report') : null));
  });
  return li;
}

/** Bottom sheet listing my photos (public + private album) to share, or upload new ones. */
async function pickPhoto(): Promise<PhotoDTO | null> {
  const mine = await api<PhotoDTO[]>('/api/me/photos');
  return new Promise((resolve) => {
    const d = h('dialog', { class: 'sheet' });
    const done = (p: PhotoDTO | null) => { d.close(); resolve(p); };
    const grid = (photos: PhotoDTO[]) => h('ul', { class: 'photo-grid' }, ...photos.map((p) => h('li', {},
      h('button', { type: 'button', class: 'photo', onclick: (() => done(p)) as EventListener }, h('img', { src: p.thumb, alt: '', loading: 'lazy' })))));
    const pub = mine.filter((p) => !p.private);
    const priv = mine.filter((p) => p.private);
    const parts: (Node | null)[] = [
      h('h2', {}, 'Share a photo'),
      h('p', { class: 'muted small' }, 'Private-album photos are shared with this friend only, one photo at a time.'),
      pub.length ? h('h3', {}, 'My photos') : null, pub.length ? grid(pub) : null,
      priv.length ? h('h3', {}, '🔒 Private album') : null, priv.length ? grid(priv) : null,
      !mine.length ? h('p', { class: 'muted' }, 'You have no photos yet.') : null,
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'quiet', onclick: (async () => {
          const up = await uploadPhotos(true, false);
          if (up[0]) done(up[0]);
        }) as EventListener }, '+ Upload to private album'),
        h('button', { type: 'button', class: 'quiet', onclick: (() => done(null)) as EventListener }, 'Cancel')),
    ];
    d.append(...(parts.filter(Boolean) as Node[]));
    d.addEventListener('close', () => { d.remove(); resolve(null); });
    document.body.append(d);
    d.showModal();
  });
}

export async function viewThread(handle: string) {
  let t: ThreadDTO;
  try {
    t = await api<ThreadDTO>(`/api/messages/${encodeURIComponent(handle)}`);
  } catch (e) {
    state.flash = (e as Error).message;
    return navigate('/messages', true);
  }
  void refreshUnread();
  const other = t.with.handle;
  const list = h('ol', { class: 'thread', 'aria-live': 'polite' });
  const older = h('button', { type: 'button', class: 'quiet wide', hidden: !t.olderCursor }, 'Show older messages');
  let cursor = t.olderCursor;
  const render = (msgs: DirectMessageDTO[], prepend = false) => {
    const items = msgs.map((m) => bubble(m, other, () => {}));
    if (prepend) list.prepend(...items);
    else list.append(...items);
  };
  render(t.messages);
  if (!t.messages.length) list.append(h('li', { class: 'muted empty' }, `Say hi to ${other}!`));
  older.addEventListener('click', async () => {
    const more = await api<ThreadDTO>(`/api/messages/${encodeURIComponent(other)}?before=${cursor}`);
    cursor = more.olderCursor;
    older.hidden = !cursor;
    render(more.messages, true);
  });

  const reload = async () => {
    const fresh = await api<ThreadDTO>(`/api/messages/${encodeURIComponent(other)}`);
    list.replaceChildren();
    render(fresh.messages);
    cursor = fresh.olderCursor;
    older.hidden = !cursor;
    requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
  };
  state.onDirectMessage = (from) => {
    if (from.toLowerCase() === other.toLowerCase()) void reload();
    else { void refreshUnread(); toast(`New message from ${from}`); }
  };
  state.cleanup = () => { state.onDirectMessage = null; };

  // ----- composer -----
  const input = h('input', { type: 'text', 'aria-label': 'Message', placeholder: `Message ${other}…`, autocomplete: 'off', enterkeyhint: 'send' });
  const counter = h('span', { class: 'counter' });
  const sendBtn = h('button', { type: 'submit', class: 'primary' }, 'Send');
  const photoBtn = h('button', { type: 'button', class: 'quiet', 'aria-label': 'Share a photo' }, '📷');
  const errBox = h('p', { class: 'notice error', role: 'alert', hidden: true });
  const update = () => {
    const left = CHAT.MAX_CHARS - visibleLength(cleanBody(input.value));
    counter.textContent = String(left);
    counter.className = 'counter' + (left < 0 ? ' over' : left <= CHAT.WARN_REMAINING ? ' warn' : '');
    sendBtn.disabled = left < 0 || left === CHAT.MAX_CHARS;
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !state.me!.prefs.enterToSend) e.preventDefault(); });
  const send = async (payload: { body?: string; photoId?: string }) => {
    errBox.hidden = true;
    try {
      await api(`/api/messages/${encodeURIComponent(other)}`, { body: payload });
      await reload();
      return true;
    } catch (e) {
      errBox.textContent = (e as Error).message;
      errBox.hidden = false;
      return false;
    }
  };
  const composer = h('form', { class: 'chat-composer dm' }, photoBtn, input, sendBtn, counter);
  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sendBtn.disabled) return;
    sendBtn.disabled = true;
    if (await send({ body: input.value })) input.value = '';
    update();
    input.focus();
  });
  photoBtn.addEventListener('click', async () => {
    const p = await pickPhoto();
    if (!p) return;
    const caption = input.value.trim();
    if (await send({ photoId: p.id, body: caption || undefined })) input.value = '';
    update();
  });
  update();

  page(other,
    h('div', { class: 'thread-head' },
      h('a', { href: '/messages', class: 'back' }, '‹ Messages'),
      h('a', { href: `/profile/${other}`, class: 'person-link' }, avatar(t.with.avatar, other), h('strong', {}, other))),
    older, list, errBox,
    t.canSend ? composer : h('p', { class: 'notice' }, t.reason ?? "You can't message this member."));
  requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
  if (t.canSend) input.focus({ preventScroll: true });
}
