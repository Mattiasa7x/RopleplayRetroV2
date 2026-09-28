import { CHAT, Trust } from '../../../shared/config.js';
import { containsBlocked, type BlockEntry } from '../../../shared/filter.js';
import { cleanBody, visibleLength } from '../../../shared/text.js';
import type { HistoryPage, MessageDTO, RoomPeopleDTO, SendResult } from '../../../shared/types.js';
import { avatar, navigate, page, state, toast } from '../core.js';
import { api, h, timeShort } from '../dom.js';

function getLastSeen(slug: string): string | null { try { return localStorage.getItem(`seen:${slug}`); } catch { return null; } }
function setLastSeen(slug: string, id: string) { try { localStorage.setItem(`seen:${slug}`, id); } catch {} }

export async function viewRoom(slug: string) {
  const s = state.socket!;
  const me = state.me!;
  let hist: HistoryPage;
  let pendingNew = 0;
  let typingTimer: number | undefined;
  const lastSeenOnEntry = getLastSeen(slug);

  const list = h('ol', { class: 'lines', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const pager = h('div', { class: 'pager' });
  const typing = h('p', { class: 'typing muted', 'aria-live': 'off' });
  const newBar = h('button', { class: 'newbar', hidden: true, type: 'button' });
  const errBox = h('p', { class: 'notice error', role: 'alert', hidden: true });
  const input = h('input', { type: 'text', name: 'body', autocomplete: 'off', 'aria-label': 'Message', placeholder: 'Say something…', enterkeyhint: 'send' });
  const counter = h('span', { class: 'counter', 'aria-live': 'polite' });
  const sendBtn = h('button', { type: 'submit', class: 'primary' }, 'Send');
  const composerBar = h('form', { class: 'chat-composer' }, input, sendBtn, counter);
  const actions = h('div', { class: 'actions', hidden: true });
  const presence = h('button', { type: 'button', class: 'people-btn', 'aria-haspopup': 'dialog' });
  let online = 0;
  const paintPresence = () => {
    presence.replaceChildren(h('span', { class: 'dot-live', 'aria-hidden': 'true' }), `${online} here · People`);
    presence.setAttribute('aria-label', `${online} ${online === 1 ? 'person' : 'people'} here. Show who.`);
  };

  // ----- who's here: pictures, names, character city and character age -----
  const peopleList = h('ul', { class: 'people room-people' });
  const peopleNote = h('p', { class: 'muted small' });
  const sheet = h('dialog', { class: 'sheet', 'aria-label': 'People in this room' },
    h('div', { class: 'thread-head' }, h('h2', {}, 'People here'),
      h('button', { type: 'button', class: 'quiet', onclick: (() => sheet.close()) as EventListener }, 'Close')),
    h('p', { class: 'muted small' }, 'Ages shown are character ages from profiles, never anyone\'s real age.'),
    peopleList, peopleNote);
  let peopleTimer: number | undefined;
  async function loadPeople() {
    try {
      const r = await api<RoomPeopleDTO>(`/api/rooms/${encodeURIComponent(slug)}/people`);
      peopleList.replaceChildren(...r.people.map((p) => {
        const details = [p.characterCity, p.characterAge != null ? `Age ${p.characterAge}` : null].filter(Boolean).join(' · ');
        return h('li', {},
          h('a', { href: `/profile/${p.handle}`, class: 'person-link', onclick: (() => sheet.close()) as EventListener },
            avatar(p.avatar, p.handle, 'md'),
            h('span', { class: 'person-text' },
              h('strong', {}, p.handle, p.self ? ' (you)' : '', p.isFriend ? h('span', { class: 'tag friend-tag' }, 'friend') : null),
              h('span', { class: 'muted small block' }, details || 'No character details'))));
      }));
      if (!r.people.length) peopleList.append(h('li', { class: 'muted' }, 'Nobody else is here right now.'));
      peopleNote.textContent = r.hidden ? `${r.hidden} ${r.hidden === 1 ? 'person' : 'people'} you've ignored or blocked ${r.hidden === 1 ? 'is' : 'are'} not shown.` : '';
    } catch (e) {
      peopleNote.textContent = (e as Error).message;
    }
  }
  presence.addEventListener('click', () => {
    peopleList.replaceChildren(h('li', { class: 'muted' }, 'Loading…'));
    sheet.showModal();
    void loadPeople();
  });
  const star = h('button', { type: 'button', class: 'star', 'aria-pressed': 'false' });

  // Rooms whose owner turned the chat filter on: swear words are stopped as they're typed.
  let roomWords: BlockEntry[] = [];
  const filterHint = h('p', { class: 'notice filter-hint', role: 'status', hidden: true }, "This room's chat filter is on: swear words can't be sent here.");
  function updateCounter() {
    const left = CHAT.MAX_CHARS - visibleLength(cleanBody(input.value));
    counter.textContent = `${left}`;
    counter.className = 'counter' + (left < 0 ? ' over' : left <= CHAT.WARN_REMAINING ? ' warn' : '');
    const flagged = roomWords.length > 0 && containsBlocked(input.value, roomWords);
    filterHint.hidden = !flagged;
    input.classList.toggle('flagged', flagged);
    sendBtn.disabled = left < 0 || left === CHAT.MAX_CHARS || flagged;
  }

  function line(m: MessageDTO): HTMLElement {
    const mine = m.userId === me.id;
    const mentioned = m.mentions.includes(me.id);
    const who = h('button', { type: 'button', class: 'who', 'aria-label': `Options for ${m.handle}` }, m.handle);
    const li = h('li', { class: `line${mine ? ' mine' : ''}${mentioned ? ' mention' : ''}`, 'data-id': m.id },
      who, h('span', { class: 'sep' }, ': '), h('span', { class: 'body' }, m.body),
      me.prefs.showTimestamps ? h('time', { datetime: m.createdAt }, ' ' + timeShort(m.createdAt)) : null);
    who.addEventListener('click', () => openActions(m, li));
    return li;
  }

  function render() {
    list.replaceChildren();
    let dividerPlaced = false;
    for (const m of hist.messages) {
      if (!dividerPlaced && hist.page === 1 && lastSeenOnEntry && BigInt(m.id) > BigInt(lastSeenOnEntry) && m !== hist.messages[0]) {
        list.append(h('li', { class: 'divider' }, 'new since you were here'));
        dividerPlaced = true;
      }
      list.append(line(m));
    }
    if (!hist.messages.length) list.append(h('li', { class: 'empty muted' }, 'No messages yet. Say hi!'));
    if (hist.page === 1) {
      pendingNew = 0;
      newBar.hidden = true;
      const last = hist.messages.at(-1);
      if (last) setLastSeen(slug, last.id);
    }
    const pagerItems: (Node | null)[] = [
      h('button', { type: 'button', class: 'quiet', disabled: !hist.olderCursor, onclick: (() => void load({ before: hist.olderCursor! })) as EventListener }, '‹ Older'),
      h('span', { class: 'muted' }, `Page ${hist.page} of ${hist.totalPages}`),
      h('button', { type: 'button', class: 'quiet', disabled: !hist.newerCursor, onclick: (() => void load({ after: hist.newerCursor! })) as EventListener }, 'Newer ›'),
      hist.newerCursor ? h('button', { type: 'button', class: 'quiet', onclick: (() => void load()) as EventListener }, 'Latest') : null,
    ];
    pager.replaceChildren(...pagerItems.filter((x): x is Node => x !== null));
  }

  async function load(q: { before?: string; after?: string } = {}) {
    const qs = new URLSearchParams(q as Record<string, string>).toString();
    hist = await api<HistoryPage>(`/api/rooms/${encodeURIComponent(slug)}/messages${qs ? '?' + qs : ''}`);
    render();
  }

  function openActions(m: MessageDTO, li: HTMLElement) {
    const done = (text: string, err = false) => { actions.hidden = true; toast(text, err); };
    const profileLink = h('a', { href: `/profile/${m.handle}`, class: 'button quiet' }, 'View profile');
    if (m.userId === me.id) {
      actions.replaceChildren(h('strong', {}, m.handle), profileLink, h('button', { type: 'button', class: 'quiet', onclick: (() => { actions.hidden = true; }) as EventListener }, 'Close'));
      actions.hidden = false;
      li.after(actions);
      return;
    }
    const reason = h('input', { type: 'text', maxlength: 300, placeholder: 'What is wrong with this message?', 'aria-label': 'Report reason' });
    const reportForm = h('form', { class: 'row report', hidden: true }, reason, h('button', { type: 'submit', class: 'primary' }, 'Send'));
    reportForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/reports', { body: { messageId: m.id, reason: reason.value || 'No reason given' } }); done('Report sent to the moderators. Thank you.'); }
      catch (x) { done((x as Error).message, true); }
    });
    const ignore = async (mode: 'ignore' | 'block') => {
      try {
        await api(`/api/ignores/${encodeURIComponent(m.handle)}`, { method: 'PUT', body: { mode } });
        list.querySelectorAll<HTMLElement>('li.line').forEach((el) => { if (el.querySelector('.who')?.textContent === m.handle) el.remove(); });
        done(mode === 'block' ? `${m.handle} is blocked. Manage in Settings.` : `${m.handle} is ignored. Manage in Settings.`);
      } catch (x) { done((x as Error).message, true); }
    };
    const modBtn = (label: string, fn: () => Promise<unknown>, ok: string) =>
      h('button', { type: 'button', class: 'mod', onclick: (async () => { try { await fn(); done(ok); } catch (x) { done((x as Error).message, true); } }) as EventListener }, label);
    const items: (Node | null)[] = [
      h('strong', {}, m.handle),
      profileLink,
      h('button', { type: 'button', class: 'quiet', onclick: (() => { input.value = `@${m.handle} ${input.value}`; input.focus(); updateCounter(); actions.hidden = true; }) as EventListener }, 'Reply @'),
      h('button', { type: 'button', class: 'quiet', onclick: (() => ignore('ignore')) as EventListener }, 'Ignore'),
      h('button', { type: 'button', class: 'quiet', onclick: (() => ignore('block')) as EventListener }, 'Block'),
      me.trust >= Trust.Verified ? h('button', { type: 'button', class: 'quiet', onclick: (() => { reportForm.hidden = false; reason.focus(); }) as EventListener }, 'Report') : null,
      ...(hist.room.canModerate ? [
        modBtn('Hide line', () => api(`/api/mod/messages/${m.id}/hide`, { body: { reason: 'Hidden by a room moderator' } }), 'Line hidden.'),
        modBtn('Kick', () => api('/api/mod/sanctions', { body: { handle: m.handle, kind: 'kick', room: slug, reason: 'Kicked by a room moderator' } }), `${m.handle} kicked for 15 minutes.`),
        modBtn('Mute', () => api('/api/mod/sanctions', { body: { handle: m.handle, kind: 'mute', room: slug, minutes: 15, reason: 'Muted by a room moderator' } }), `${m.handle} muted for 15 minutes.`),
      ] : []),
      h('button', { type: 'button', class: 'quiet', onclick: (() => { actions.hidden = true; }) as EventListener }, 'Close'),
      reportForm,
    ];
    actions.replaceChildren(...items.filter((x): x is Node => x !== null));
    actions.hidden = false;
    li.after(actions);
  }

  // ----- live events -----
  const onNew = (m: MessageDTO) => {
    if (m.roomId !== state.currentRoomId) return;
    if (hist.page === 1 && !hist.newerCursor) {
      hist.messages.push(m);
      if (hist.messages.length > CHAT.PAGE_SIZE) hist.messages.shift();
      list.querySelector('.empty')?.remove();
      const lines = list.querySelectorAll('li.line');
      if (lines.length >= CHAT.PAGE_SIZE) lines[0].remove();
      list.append(line(m));
      setLastSeen(slug, m.id);
      typing.textContent = '';
      list.lastElementChild?.scrollIntoView({ block: 'nearest' });
    } else {
      pendingNew++;
      newBar.textContent = `${pendingNew} new · back to latest`;
      newBar.hidden = false;
    }
  };
  const onHidden = (p: { id: string; roomId: number }) => {
    if (p.roomId !== state.currentRoomId) return;
    list.querySelector(`li[data-id="${CSS.escape(p.id)}"]`)?.remove();
    hist.messages = hist.messages.filter((m) => m.id !== p.id);
  };
  const onTyping = (p: { roomId: number; handle: string }) => {
    if (p.roomId !== state.currentRoomId) return;
    typing.textContent = `${p.handle} is typing…`;
    clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => { typing.textContent = ''; }, 4000);
  };
  const onPresence = (p: { roomId: number; online: number }) => {
    if (p.roomId !== state.currentRoomId) return;
    online = p.online;
    paintPresence();
    if (sheet.open) {
      clearTimeout(peopleTimer);
      peopleTimer = window.setTimeout(() => void loadPeople(), 700);
    }
  };
  const onReconnect = () => {
    s.emit('room:join', { slug }, () => {});
    if (hist?.page === 1) void load();
  };
  s.on('msg:new', onNew);
  s.on('msg:hidden', onHidden);
  s.on('typing', onTyping);
  s.on('presence', onPresence);
  s.io.on('reconnect', onReconnect);
  state.cleanup = () => {
    s.off('msg:new', onNew);
    s.off('msg:hidden', onHidden);
    s.off('typing', onTyping);
    s.off('presence', onPresence);
    s.io.off('reconnect', onReconnect);
    s.emit('room:leave');
    state.currentRoomId = null;
    clearTimeout(peopleTimer);
    if (sheet.open) sheet.close();
  };

  newBar.addEventListener('click', () => void load());

  let lastTypingSent = 0;
  input.addEventListener('input', () => {
    updateCounter();
    if (Date.now() - lastTypingSent > 3000 && input.value) { lastTypingSent = Date.now(); s.emit('typing', { slug }); }
  });
  // "Enter to send" off: the Enter key does nothing, so a stray tap on a phone keyboard never sends.
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !me.prefs.enterToSend) e.preventDefault(); });
  composerBar.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sendBtn.disabled) return;
    sendBtn.disabled = true;
    errBox.hidden = true;
    s.timeout(8000).emit('msg:send', { slug, body: input.value }, (err: Error | null, r: SendResult) => {
      if (err) { errBox.textContent = 'Not sent: connection problem. Try again.'; errBox.hidden = false; }
      else if (!r.ok) { errBox.textContent = r.message; errBox.hidden = false; }
      else {
        input.value = '';
        if (hist.page !== 1 || hist.newerCursor) void load();
      }
      updateCounter();
      input.focus();
    });
  });

  // ----- enter the room -----
  const joined = await new Promise<{ ok: boolean; message?: string; roomId?: number }>((res) => s.emit('room:join', { slug }, res));
  if (!joined.ok) {
    state.flash = joined.message ?? 'Could not open that room.';
    return navigate('/rooms', true);
  }
  state.currentRoomId = joined.roomId!;
  try {
    await load();
  } catch (e) {
    state.flash = (e as Error).message;
    return navigate('/rooms', true);
  }

  // Favorite star (shows on Home).
  const rooms = await api<{ slug: string; favorite: boolean }[]>('/api/rooms');
  let fav = !!rooms.find((r) => r.slug === slug)?.favorite;
  const paintStar = () => {
    star.textContent = fav ? '★ Favorited' : '☆ Favorite';
    star.setAttribute('aria-pressed', String(fav));
  };
  star.addEventListener('click', async () => {
    try {
      await api(`/api/favorites/${encodeURIComponent(slug)}`, { method: fav ? 'DELETE' : 'PUT', body: fav ? undefined : {} });
      fav = !fav;
      paintStar();
    } catch (e) { toast((e as Error).message, true); }
  });
  paintStar();

  const room = hist!.room;
  if (room.chatFilter) {
    composerBar.prepend(filterHint);
    try { roomWords = (await api<{ entries: BlockEntry[] }>('/api/filter/room-words')).entries; } catch { /* the server still checks on send */ }
  }
  online = Math.max(online, room.online);
  paintPresence();
  page(room.name,
    h('div', { class: `room-banner ${room.kind === 'member' ? 'art-member' : 'art-genre'}` },
      room.image ? h('img', { src: room.image, alt: '' }) : null,
      h('span', { class: 'banner-name' }, room.name),
      room.imageCredit ? h('a', { class: 'banner-credit', href: room.imageCredit.url, target: '_blank', rel: 'noopener noreferrer' }, `Photo: ${room.imageCredit.name} / Unsplash`) : null),
    h('div', { class: 'room-head' },
      h('div', {},
        h('div', { class: 'room-tags' },
          h('span', { class: 'tag' }, room.kind === 'site' ? 'Site room' : 'Member room'),
          room.whitelistOnly ? h('span', { class: 'tag' }, 'Invite-only') : null,
          room.chatFilter ? h('span', { class: 'tag' }, 'Chat filter on') : null,
          presence),
        h('p', { class: 'muted small' }, room.kind === 'site' ? 'Strictly auto-moderated · no links' : room.description ?? '')),
      h('div', { class: 'row' }, star, room.canManage && room.kind === 'member' ? h('a', { href: `/room/${slug}/manage`, class: 'button quiet' }, 'Manage') : null)),
    pager, newBar,
    h('div', { class: 'chat-box' }, list, actions),
    typing, errBox, composerBar, sheet);
  updateCounter();
  // Open at the newest lines with the message box in view, like any chat.
  requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
  // On phones, wait for a tap: focusing would pop the keyboard up and tuck the bottom buttons away.
  if (!window.matchMedia('(pointer: coarse)').matches) input.focus({ preventScroll: true });
}
