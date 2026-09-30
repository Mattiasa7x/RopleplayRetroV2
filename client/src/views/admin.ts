import { Trust } from '../../../shared/config.js';
import { card, page, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';

interface Flag {
  id: string; kind: string; target_id: string | null; reason: string; created_at: string;
  snapshot: { message?: { handle: string; body: string; room: string | null }; context?: { handle: string; body: string }[] };
  reporter: string; target: string; room: string | null; report_count: number; target_banned: boolean;
}
interface PendingPhoto { id: string; handle: string; created_at: string; width: number | null; height: number | null; thumb: string; url: string }
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
  if (!flags.length) return card(null, h('p', { class: 'muted' }, 'Nothing flagged right now.'));
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

/** New public photos waiting for approval, oldest first. Private-album photos never come here. */
async function photosPane(reload: () => void): Promise<HTMLElement> {
  const d = await api<{ total: number; photos: PendingPhoto[] }>('/api/admin/photos');
  if (!d.photos.length) return card(null, h('p', { class: 'muted' }, 'No photos waiting for approval.'));
  const decide = async (action: 'approve' | 'deny', ids: string[]) => {
    const r = await api<{ approved?: number; denied?: number }>(`/api/admin/photos/${action}`, { body: { ids } });
    const n = r.approved ?? r.denied ?? 0;
    toast(`${n} photo${n === 1 ? '' : 's'} ${action === 'approve' ? 'approved' : 'denied and removed'}.`);
  };
  const tile = (ph: PendingPhoto) => {
    const li = h('li', { class: 'review-tile' },
      h('a', { href: ph.url, target: '_blank', rel: 'noopener', class: 'photo', 'aria-label': `Open ${ph.handle}'s photo full size` },
        h('img', { src: ph.thumb, alt: '', loading: 'lazy' })),
      h('p', { class: 'small review-meta' }, h('a', { href: `/profile/${ph.handle}` }, h('strong', {}, ph.handle)),
        h('span', { class: 'muted' }, ` · ${timeAgo(ph.created_at)}${ph.width ? ` · ${ph.width}×${ph.height}` : ''}`)),
      h('div', { class: 'review-actions' },
        h('button', { type: 'button', class: 'primary', onclick: (async () => {
          try { await decide('approve', [ph.id]); li.remove(); } catch (e) { toast((e as Error).message, true); }
        }) as EventListener }, 'Approve'),
        twoStep('Deny', 'Tap again', 'danger', async () => { await decide('deny', [ph.id]); li.remove(); })));
    return li;
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'row wrap review-head' },
      h('p', { class: 'muted small' }, `${d.total} waiting${d.total > d.photos.length ? ` · showing the oldest ${d.photos.length}` : ''}. Tap a photo to see it full size. Denied photos are deleted.`),
      twoStep(`Approve all ${d.photos.length}`, 'Tap again to approve all', 'quiet', async () => { await decide('approve', d.photos.map((p) => p.id)); reload(); })),
    h('ul', { class: 'review-grid' }, ...d.photos.map(tile)));
}

/** The admin's page: flagged content first, then bans. Only the site owner's account sees it. */
export async function viewAdmin() {
  if ((state.me?.trust ?? 0) < Trust.Admin) {
    page('Admin', h('p', { class: 'notice' }, 'This page is for the site admin.'));
    return;
  }
  const want = new URLSearchParams(location.search).get('tab');
  const tab = want === 'bans' || want === 'photos' ? want : 'flagged';
  const reload = () => void viewAdmin();
  page('Admin', h('p', { class: 'muted' }, 'Loading…'));
  const body = tab === 'bans' ? await bansPane(reload) : tab === 'photos' ? await photosPane(reload) : await flaggedPane(reload);
  const tabBtn = (id: string, label: string) => h('a', { href: `/admin?tab=${id}`, class: `button ${tab === id ? 'primary' : 'quiet'}` }, label);
  page('Admin',
    h('div', { class: 'row admin-tabs' }, tabBtn('flagged', 'Flagged'), tabBtn('photos', 'Photos'), tabBtn('bans', 'Bans')),
    h('p', { class: 'muted small' }, tab === 'photos'
      ? 'New public photos wait here for approval. Private-album photos are never reviewed.'
      : 'You see flagged content and new public photos. Private messages and albums stay private unless reported.'),
    body);
}
