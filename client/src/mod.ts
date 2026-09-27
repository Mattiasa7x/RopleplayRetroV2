import { Trust } from '../../shared/config.js';
import type { MeDTO } from '../../shared/types.js';
import { ApiErr, api, h, mount, timeShort } from './dom.js';

const root = document.getElementById('app')!;
let me: MeDTO;

interface Report {
  id: string; message_id: string; reason: string; created_at: string; reporter: string; target: string;
  room: string | null; report_count: string; hidden: boolean | null;
  snapshot: { message: { id: string; handle: string; body: string; createdAt: string }; context: { handle: string; body: string; created_at: string }[] };
}

function toast(text: string, error = false) {
  const t = h('div', { class: `toast${error ? ' error' : ''}`, role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

async function act(fn: () => Promise<unknown>, ok: string, then?: () => void) {
  try {
    await fn();
    toast(ok);
    then?.();
  } catch (e) {
    toast(e instanceof ApiErr ? e.message : 'Failed.', true);
  }
}

function sanctionForm(handle: string, room: string | null, onDone: () => void): HTMLElement {
  const kind = h('select', { name: 'kind', 'aria-label': 'Action' },
    h('option', { value: 'mute' }, 'Mute'), h('option', { value: 'kick' }, 'Kick from room (15 min)'),
    h('option', { value: 'ban' }, 'Ban'), h('option', { value: 'shadow_mute' }, 'Shadow-mute'));
  const scope = h('select', { name: 'scope', 'aria-label': 'Scope' },
    room ? h('option', { value: room }, `Room: ${room}`) : null,
    me.trust >= Trust.Admin ? h('option', { value: '' }, 'Site-wide') : null);
  const minutes = h('input', { type: 'number', name: 'minutes', min: 1, placeholder: 'minutes (blank = permanent)', 'aria-label': 'Minutes' });
  const reason = h('input', { type: 'text', name: 'reason', required: true, maxlength: 300, placeholder: 'Reason (shown to the member for mutes)', 'aria-label': 'Reason' });
  const f = h('form', { class: 'row' }, kind, scope, minutes, reason, h('button', { type: 'submit' }, 'Apply'));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const body: Record<string, unknown> = { handle, kind: kind.value, reason: reason.value };
    if (scope.value) body.room = scope.value;
    if (minutes.value) body.minutes = Number(minutes.value);
    void act(() => api('/api/mod/sanctions', { body }), `${kind.value.replace('_', '-')} applied to ${handle}.`, onDone);
  });
  return f;
}

async function viewReports(status = 'open') {
  const rows = await api<Report[]>(`/api/mod/reports?status=${status}`);
  const reload = () => void viewReports(status);
  const cards = rows.map((r) => {
    const s = r.snapshot;
    return h('article', { class: 'card' },
      h('p', { class: 'small' }, `#${r.id} · ${r.room ?? 'room deleted'} · reported by ${r.reporter} · ${r.report_count} report(s) on this line${r.hidden ? ' · hidden' : ''}`),
      h('ol', { class: 'lines context' },
        ...s.context.map((c) => h('li', { class: 'line' }, h('b', {}, c.handle), ': ', c.body)),
        h('li', { class: 'line flagged' }, h('b', {}, s.message.handle), ': ', s.message.body, h('time', {}, ' ' + timeShort(s.message.createdAt)))),
      h('p', {}, h('strong', {}, 'Reason: '), r.reason),
      status === 'open' ? h('div', { class: 'row' },
        !r.hidden ? h('button', { type: 'button', onclick: (() => act(() => api(`/api/mod/messages/${r.message_id}/hide`, { body: { reason: r.reason } }), 'Message hidden.', reload)) as EventListener }, 'Hide message') : null,
        h('button', { type: 'button', onclick: (() => act(() => api(`/api/mod/reports/${r.id}/resolve`, { body: { status: 'actioned' } }), 'Marked actioned.', reload)) as EventListener }, 'Mark actioned'),
        h('button', { type: 'button', class: 'quiet', onclick: (() => act(() => api(`/api/mod/reports/${r.id}/resolve`, { body: { status: 'dismissed' } }), 'Dismissed.', reload)) as EventListener }, 'Dismiss'),
        h('button', { type: 'button', class: 'quiet', onclick: (() => void viewUser(r.target)) as EventListener }, `History for ${r.target}`)) : null,
      status === 'open' ? sanctionForm(r.target, r.room, reload) : null);
  });
  mount(main, h('h2', {}, `Reports: ${status}`),
    h('div', { class: 'row' }, ...['open', 'actioned', 'dismissed'].map((st) => h('button', { type: 'button', class: st === status ? '' : 'quiet', onclick: (() => void viewReports(st)) as EventListener }, st))),
    ...(cards.length ? cards : [h('p', {}, 'Nothing here. Nice.')]));
}

async function viewUser(handle: string) {
  const data = await api<{ user: Record<string, unknown>; sanctions: Record<string, string | null>[] }>(`/api/mod/users/${encodeURIComponent(handle)}`);
  const u = data.user;
  mount(main, h('h2', {}, String(u.handle)),
    h('p', {}, `Level ${u.trust_level} · joined ${new Date(String(u.created_at)).toLocaleDateString()} · ${u.message_count} messages · ${u.verified ? 'email confirmed' : 'unconfirmed'}${u.needs_review ? ' · flagged for review' : ''}`),
    sanctionForm(String(u.handle), null, () => void viewUser(handle)),
    h('h3', {}, 'Sanction history'),
    h('ul', {}, ...data.sanctions.map((s) => h('li', {},
      `${s.kind} · ${s.room ?? 'site-wide'} · ${s.reason} · by ${s.issued_by ?? 'system'} · ${new Date(String(s.created_at)).toLocaleString()}`,
      s.expires_at ? ` · until ${new Date(s.expires_at).toLocaleString()}` : '',
      s.revoked_at ? ' · revoked' : ' ',
      !s.revoked_at ? h('button', { type: 'button', class: 'quiet', onclick: (() => act(() => api(`/api/mod/sanctions/${s.id}/revoke`, { body: {} }), 'Revoked.', () => void viewUser(handle))) as EventListener }, 'Revoke') : null))));
}

async function viewReview() {
  const rows = await api<{ handle: string; created_at: string; message_count: number; matched_handle: string | null }[]>('/api/mod/review');
  mount(main, h('h2', {}, 'Ban-evasion review'),
    h('p', { class: 'small' }, 'These accounts share device or network signals with a banned account. New ones are shadow-muted until you decide.'),
    ...(rows.length ? rows.map((r) => h('article', { class: 'card' },
      h('p', {}, h('strong', {}, r.handle), ` · joined ${new Date(r.created_at).toLocaleString()} · ${r.message_count} messages · matches ${r.matched_handle ?? 'a banned account'}`),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: (() => act(() => api(`/api/mod/review/${r.handle}`, { body: { decision: 'clear' } }), 'Cleared.', () => void viewReview())) as EventListener }, 'Clear (not the same person)'),
        h('button', { type: 'button', onclick: (() => act(() => api(`/api/mod/review/${r.handle}`, { body: { decision: 'ban' } }), 'Banned.', () => void viewReview())) as EventListener }, 'Ban (evasion)')))) : [h('p', {}, 'Nobody waiting.')]));
}

async function viewAudit(before?: string) {
  const rows = await api<{ id: string; action: string; target_type: string; target_id: string; detail: unknown; created_at: string; actor: string | null }[]>(`/api/mod/audit${before ? `?before=${before}` : ''}`);
  mount(main, h('h2', {}, 'Audit log'),
    h('table', {}, h('thead', {}, h('tr', {}, ...['When', 'Who', 'Action', 'Target', 'Detail'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...rows.map((r) => h('tr', {},
        h('td', {}, new Date(r.created_at).toLocaleString()), h('td', {}, r.actor ?? 'system'), h('td', {}, r.action),
        h('td', {}, `${r.target_type} ${r.target_id}`), h('td', { class: 'small' }, JSON.stringify(r.detail)))))),
    rows.length === 50 ? h('button', { type: 'button', onclick: (() => void viewAudit(rows.at(-1)!.id)) as EventListener }, 'Older') : null);
}

const main = h('main', {});
const lookup = h('form', { class: 'row' }, h('input', { type: 'text', name: 'q', placeholder: 'Look up a handle', 'aria-label': 'Look up a handle', maxlength: 16 }), h('button', { type: 'submit' }, 'Go'));
lookup.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = (lookup.elements.namedItem('q') as HTMLInputElement).value.trim();
  if (q) void viewUser(q).catch((x) => toast((x as Error).message, true));
});

try {
  me = await api<MeDTO>('/api/me');
  const dark = me.prefs.theme === 'dark' || (me.prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.size = me.prefs.textSize ?? 'm';
  if (me.trust < Trust.RoomModerator) throw new ApiErr('not_mod', 'Moderators only.', 403);
  const tabs = h('nav', { class: 'row tabs' },
    h('button', { type: 'button', onclick: (() => void viewReports()) as EventListener }, 'Reports'),
    me.trust >= Trust.Admin ? h('button', { type: 'button', onclick: (() => void viewReview()) as EventListener }, 'Review queue') : null,
    me.trust >= Trust.Admin ? h('button', { type: 'button', onclick: (() => void viewAudit()) as EventListener }, 'Audit log') : null,
    h('a', { href: '/home' }, 'Back to site'));
  mount(root, h('header', { class: 'bar' }, h('span', { class: 'brand' }, 'Moderator console'), h('span', { class: 'right' }, me.handle)), tabs, lookup, main);
  await viewReports();
} catch (e) {
  mount(root, h('p', { class: 'notice error' }, e instanceof ApiErr ? e.message : 'Please log in first.'), h('a', { href: '/login' }, 'Log in'));
}
