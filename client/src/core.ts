import { io, type Socket } from 'socket.io-client';
import { SITE_NAME, type Prefs } from '../../shared/config.js';
import type { ClientToServer, MeDTO, ServerToClient } from '../../shared/types.js';
import { api, h } from './dom.js';

export type Sock = Socket<ServerToClient, ClientToServer>;

/** Shared page state. */
export const state = {
  me: null as MeDTO | null,
  socket: null as Sock | null,
  flash: null as string | null,
  friendRequests: 0,
  unreadMessages: 0,
  /** Set by an open conversation so a new message from that person refreshes it. */
  onDirectMessage: null as ((from: string) => void) | null,
  /** Set by the chat page so socket events know which room is open. */
  currentRoomId: null as number | null,
  /** Called when leaving a page (the chat page unsubscribes its socket listeners). */
  cleanup: null as (() => void) | null,
};

export const root = () => document.getElementById('app')!;

// ---------------- navigation: real addresses, no reloads ----------------

let router: () => Promise<void> = async () => {};
export function setRouter(fn: () => Promise<void>) {
  router = fn;
}

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  window.scrollTo(0, 0);
  void router();
}

// Ordinary <a href="/..."> links move between pages without a full reload.
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('/uploads/') || href === '/mod') return;
  e.preventDefault();
  navigate(href);
});
window.addEventListener('popstate', () => void router());

// ---------------- theme and text size ----------------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let currentTheme: Prefs['theme'] = 'system';

export function applyPrefs(p: Partial<Prefs>) {
  currentTheme = p.theme ?? currentTheme;
  const dark = currentTheme === 'dark' || (currentTheme === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.size = p.textSize ?? document.documentElement.dataset.size ?? 'm';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#ffffff');
  try {
    localStorage.setItem('prefs', JSON.stringify({ theme: currentTheme, textSize: document.documentElement.dataset.size }));
  } catch {}
}
darkQuery.addEventListener('change', () => applyPrefs({}));
try {
  applyPrefs(JSON.parse(localStorage.getItem('prefs') ?? '{}'));
} catch {
  applyPrefs({});
}

// ---------------- page frame ----------------

const NAV: { label: string; path: () => string; match: RegExp; icon: string }[] = [
  { label: 'Home', path: () => '/home', match: /^\/home/, icon: '⌂' },
  { label: 'Rooms', path: () => '/rooms', match: /^\/(rooms|room\/|new-room)/, icon: '#' },
  { label: 'Messages', path: () => '/messages', match: /^\/messages/, icon: '✉' },
  { label: 'Friends', path: () => '/friends', match: /^\/friends/, icon: '☺' },
  { label: 'Profile', path: () => `/profile/${state.me?.handle ?? ''}`, match: new RegExp(`^/profile/${state.me?.handle ?? '__none__'}$`, 'i'), icon: '◉' },
  { label: 'Settings', path: () => '/settings', match: /^\/settings/, icon: '⚙' },
];

/** Render a page: site header with navigation, then the page's own content. */
export function page(title: string, ...content: (Node | string | null | undefined | false)[]) {
  const here = location.pathname;
  const header = h('header', { class: 'site-header' },
    h('div', { class: 'site-bar' },
      h('a', { href: state.me ? '/home' : '/login', class: 'brand', 'aria-label': `${SITE_NAME} home` },
        h('img', { src: '/logo-mark.svg', alt: '', class: 'brand-mark light-only', width: 34, height: 31 }),
        h('img', { src: '/logo-mark-dark.svg', alt: '', class: 'brand-mark dark-only', width: 34, height: 31 }),
        h('span', { class: 'brand-word', 'aria-hidden': 'true' }, 'ROLEPLAY', h('span', {}, 'RETRO'))),
      h('span', { class: 'page-title' }, title)),
    state.me
      ? h('nav', { class: 'site-nav', 'aria-label': 'Main' }, ...NAV.map((n) => {
          const active = n.label === 'Profile' ? here.toLowerCase() === n.path().toLowerCase() : n.match.test(here);
          return h('a', { href: n.path(), class: active ? 'active' : '', 'aria-current': active ? 'page' : undefined },
            h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, n.icon),
            h('span', { class: 'nav-label' }, n.label),
            n.label === 'Friends' && state.friendRequests ? h('span', { class: 'badge', 'aria-label': `${state.friendRequests} requests` }, String(state.friendRequests)) : null,
            n.label === 'Messages' ? h('span', { class: 'badge', 'data-badge': 'messages', hidden: !state.unreadMessages, 'aria-label': `${state.unreadMessages} unread` }, String(state.unreadMessages)) : null);
        }))
      : null);
  const main = h('main', { class: 'content', id: 'main' }, takeFlash(), ...(content.filter(Boolean) as (Node | string)[]));
  root().replaceChildren(header, main);
  document.title = `${title} · ${SITE_NAME}`;
}

export function takeFlash(): HTMLElement | null {
  const text = state.flash;
  state.flash = null;
  return text ? h('p', { class: 'notice', role: 'status' }, text) : null;
}

export function toast(text: string, error = false) {
  const t = h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 4500);
}

export function card(title: string | null, ...children: (Node | string | null | undefined | false)[]): HTMLElement {
  return h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...children);
}

export function avatar(url: string | null, handle: string, size: 'sm' | 'md' | 'lg' = 'sm'): HTMLElement {
  return url
    ? h('img', { class: `avatar ${size}`, src: url, alt: '', loading: 'lazy' })
    : h('span', { class: `avatar ${size} placeholder`, 'aria-hidden': 'true' }, handle.slice(0, 1).toUpperCase());
}

export function timeAgo(iso: string): string {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------------- live connection ----------------

export async function refreshMe(): Promise<MeDTO | null> {
  try {
    state.me = await api<MeDTO>('/api/me');
    applyPrefs(state.me.prefs);
  } catch {
    state.me = null;
  }
  return state.me;
}

export function connect() {
  if (state.socket) return;
  const s: Sock = io({ withCredentials: true });
  state.socket = s;
  s.on('mention', (p) => {
    if (state.me?.prefs.mentionAlerts && state.currentRoomId !== p.roomId) toast(`${p.from} mentioned you in ${p.roomSlug}`);
  });
  s.on('notice', (p) => toast(p.message));
  s.on('social', (p) => {
    if (p.kind === 'friend_request') state.friendRequests++;
    if (!state.me?.prefs.friendAlerts) return;
    toast(p.kind === 'friend_request' ? `${p.from} sent you a friend request` : p.kind === 'friend_accept' ? `${p.from} accepted your friend request` : `${p.from} commented on your profile`);
  });
  s.on('dm', (p) => {
    if (state.onDirectMessage) {
      state.onDirectMessage(p.from);
      return;
    }
    setUnread(state.unreadMessages + 1);
    toast(`New message from ${p.from}`);
  });
  s.on('kicked', (p) => {
    if (state.currentRoomId === p.roomId) {
      state.flash = `You were removed from that room. ${p.reason}`;
      navigate('/rooms');
    }
  });
  s.on('connect_error', (e) => {
    if (e.message === 'login') disconnect();
  });
}

export function disconnect() {
  state.socket?.close();
  state.socket = null;
}

/** A form with an error line and a submit button that disables while working. */
export function form(fields: (Node | null)[], submitLabel: string, onSubmit: (data: FormData, err: (m: string) => void) => Promise<void>, extraClass = ''): HTMLFormElement {
  const errBox = h('p', { class: 'notice error', role: 'alert', hidden: true });
  const f = h('form', { class: `stack ${extraClass}` }, errBox, ...(fields.filter(Boolean) as Node[]), h('button', { type: 'submit', class: 'primary' }, submitLabel));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    const btn = f.querySelector<HTMLButtonElement>('button[type=submit]')!;
    btn.disabled = true;
    try {
      await onSubmit(new FormData(f), (m) => { errBox.textContent = m; errBox.hidden = false; });
    } catch (x) {
      errBox.textContent = (x as Error).message || 'Something went wrong.';
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  return f;
}

export const field = (label: string, name: string, type = 'text', extra: Record<string, string | number | boolean | undefined> = {}) =>
  h('label', { class: 'field' }, h('span', {}, label), h('input', { name, type, required: true, ...extra }));

/** Update the Messages badge in place (no page redraw). */
export function setUnread(n: number) {
  state.unreadMessages = Math.max(0, n);
  const b = document.querySelector<HTMLElement>('[data-badge="messages"]');
  if (b) {
    b.textContent = String(state.unreadMessages);
    b.hidden = !state.unreadMessages;
  }
}

export async function refreshUnread() {
  try {
    const r = await api<{ unread: number }>('/api/messages/unread-count');
    setUnread(r.unread);
  } catch {}
}
