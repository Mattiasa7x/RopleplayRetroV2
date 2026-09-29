import { Trust } from '../../../shared/config.js';
import { card, page, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';

interface Flag {
  id: string; kind: string; target_id: string | null; reason: string; created_at: string;
  snapshot: { message?: { handle: string; body: string; room: string | null }; context?: { handle: string; body: string }[] };
  reporter: string; target: string; room: string | null; report_count: number; target_banned: boolean;
}
interface Ban { id: string; handle: string; reason: string; created_at: string; blocked: number }

const KIND_LABEL: Record<string, string> = {
  message: 'Chat line', dm: 'Private message', comment: 'Profile comment', photo_comment: 'Photo comment',
  status: 'Status', photo: 'Photo', profile: 'Profile', gift: 'Gift message',
};

/** A button that asks "Tap again to …" before doing something permanent (no browser pop-ups). */
function twoStep(label: string, confirmLabel: string, cls: string, run: () => Promise<void>): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls }, label);
  let armed = false;
  let timer: number | undefined;
  b.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      b.classList.add('armed');
      timer = window.setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('armed'); }, 4000);
      return;
    }
    clearTimeout(timer);
    b.disabled = true;
    try { await run(); } catch (e) { toast((e as Error).message, true); b.disabled = false; }
  });
  return b;
}

function banForm(handle: string, done: () => void): HTMLElement {
  const reason = h('input', { type: 'text', maxlength: 300, placeholder: 'Reason (kept in the audit log)', 'aria-label': 'Reason for the ban' });
  const net = h('input', { type: 'checkbox', checked: true });
  const f = h('form', { class: 'stack ban-form' },
    reason,
    h('label', { class: 'check' }, net, h('span', {}, 'Also block the connection and devices they used in the last 30 days')),
    h('button', { type: 'submit', class: 'danger' }, `Ban ${handle} from the site`));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (reason.value.trim().length < 3) return toast('Give a short reason first.', true);
    try {
      const r = await api<{ blocked: number }>('/api/admin/ban', { body: { handle, reason: reason.value.trim(), blockConnection: net.checked } });
      toast(`${handle} is banned${net.checked ? ` and ${r.blocked} connection/device record${r.blocked === 1 ? '' : 's'} blocked` : ''}.`);
      done();
    } catch (x) { toast((x as Error).message, true); }
  });
  return f;
}

async function flaggedPane(reload: () => void): Promise<HTMLElement> {
  const flags = await api<Flag[]>('/api/admin/flagged');
  if (!flags.length) return card(null, h('p', { class: 'muted' }, 'Nothing flagged right now. Automatic moderation is keeping up.'));
  return h('div', { class: 'stack' }, ...flags.map((f) => {
    const msg = f.snapshot.message;
    const banSlot = h('div', {});
    const deletable = f.kind !== 'profile' && f.target_id;
    return h('article', { class: 'card flag' },
      h('div', { class: 'flag-head' },
        h('span', { class: 'tag' }, KIND_LABEL[f.kind] ?? f.kind),
        f.room ? h('a', { href: `/room/${f.room}` }, `#${f.room}`) : null,
        h('span', { class: 'muted small' }, timeAgo(f.created_at)),
        f.report_count > 1 ? h('span', { class: 'badge' }, `${f.report_count} reports`) : null),
      f.snapshot.context?.length
        ? h('ul', { class: 'flag-context' }, ...f.snapshot.context.map((c) => h('li', { class: 'muted small' }, h('strong', {}, c.handle), `: ${c.body}`)))
        : null,
      h('p', { class: 'flag-body' }, h('a', { href: `/profile/${f.target}` }, h('strong', {}, f.target)), ': ', msg?.body ?? ''),
      h('p', { class: 'muted small' }, `Flagged by ${f.reporter}: “${f.reason}”`),
      f.target_banned ? h('p', { class: 'notice' }, `${f.target} is already banned.`) : null,
      h('div', { class: 'row wrap' },
        deletable ? twoStep('Delete it', 'Tap again to delete', 'danger', async () => {
          await api('/api/admin/delete', { body: { kind: f.kind, id: f.target_id } });
          toast('Deleted.');
          reload();
        }) : null,
        f.target_banned ? null : h('button', { type: 'button', class: 'quiet', onclick: (() => banSlot.replaceChildren(banForm(f.target, reload))) as EventListener }, `Ban ${f.target}…`),
        h('button', { type: 'button', class: 'quiet', onclick: (async () => {
          try { await api(`/api/admin/reports/${f.id}/dismiss`, { body: {} }); toast('Dismissed.'); reload(); } catch (e) { toast((e as Error).message, true); }
        }) as EventListener }, 'Dismiss')),
      banSlot);
  }));
}

async function bansPane(reload: () => void): Promise<HTMLElement> {
  const bans = await api<Ban[]>('/api/admin/bans');
  const who = h('input', { type: 'text', maxlength: 16, placeholder: 'Member name', autocapitalize: 'off', 'aria-label': 'Member to ban' });
  const slot = h('div', {});
  const find = h('button', { type: 'button', class: 'quiet' }, 'Next');
  find.addEventListener('click', () => { if (who.value.trim()) slot.replaceChildren(banForm(who.value.trim(), reload)); });
  return h('div', { class: 'stack' },
    card('Ban a member', h('div', { class: 'row' }, who, find), slot),
    card(`Banned (${bans.length})`,
      bans.length
        ? h('ul', { class: 'people' }, ...bans.map((b) => h('li', {},
            h('span', { class: 'person-text' },
              h('a', { href: `/profile/${b.handle}` }, h('strong', {}, b.handle)),
              h('span', { class: 'muted small block' }, `${b.reason} · ${timeAgo(b.created_at)}${b.blocked ? ` · ${b.blocked} blocked` : ''}`)),
            twoStep('Lift ban', 'Tap again to lift', 'quiet', async () => {
              await api(`/api/admin/bans/${b.id}/lift`, { body: {} });
              toast(`${b.handle} can use the site again.`);
              reload();
            }))))
        : h('p', { class: 'muted' }, 'Nobody is banned.')));
}

/** The admin's page: flagged content first, then bans. Only the site owner's account sees it. */
export async function viewAdmin() {
  if ((state.me?.trust ?? 0) < Trust.Admin) {
    page('Admin', h('p', { class: 'notice' }, 'This page is for the site admin.'));
    return;
  }
  const tab = new URLSearchParams(location.search).get('tab') === 'bans' ? 'bans' : 'flagged';
  const reload = () => void viewAdmin();
  page('Admin', h('p', { class: 'muted' }, 'Loading…'));
  const body = tab === 'bans' ? await bansPane(reload) : await flaggedPane(reload);
  const tabBtn = (id: string, label: string) => h('a', { href: `/admin?tab=${id}`, class: `button ${tab === id ? 'primary' : 'quiet'}` }, label);
  page('Admin',
    h('div', { class: 'row admin-tabs' }, tabBtn('flagged', 'Flagged'), tabBtn('bans', 'Bans')),
    h('p', { class: 'muted small' }, 'For when automatic moderation misses something. You only see what members flag; private messages stay private unless one is reported to you.'),
    body);
}
