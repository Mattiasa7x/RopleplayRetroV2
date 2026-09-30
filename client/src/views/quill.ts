import { QUILL_NAME, QUILL_PASSES, QUILL_PASS_BY_ID, QUILL_PERKS, quillActive, type QuillPassId } from '../../../shared/quill.js';
import type { MeDTO, QuillStatusDTO } from '../../../shared/types.js';
import { card, navigate, page, state, toast } from '../core.js';
import { api, h } from '../dom.js';

export const meIsQuill = () => quillActive(state.me?.quillUntil);

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "3 days, 4 hours left" */
function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'ended';
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}${hours % 24 ? `, ${hours % 24} hour${hours % 24 === 1 ? '' : 's'}` : ''} left`;
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} left`;
  return `${Math.max(1, Math.round(ms / 60_000))} minutes left`;
}

/** Start a PayPal checkout for a pass (leaves the site for PayPal, then comes back). */
async function buy(pass: QuillPassId, btn: HTMLButtonElement) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Opening PayPal…';
  try {
    const r = await api<{ url: string }>('/api/quill/checkout', { body: { pass } });
    location.href = r.url;
  } catch (e) {
    toast((e as Error).message, true);
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** The three passes as cards with a PayPal button each. */
function passCards(st: QuillStatusDTO): HTMLElement {
  return h('div', { class: 'quill-passes' }, ...QUILL_PASSES.map((p) => {
    const btn = h('button', { type: 'button', class: 'paypal-btn', disabled: !st.available }, st.available ? 'Pay with PayPal' : 'Coming soon');
    btn.addEventListener('click', () => void buy(p.id, btn));
    return h('div', { class: `quill-pass${p.id === 'month' ? ' best' : ''}` },
      p.id === 'month' ? h('span', { class: 'quill-best' }, 'Best value') : null,
      h('span', { class: 'quill-pass-name' }, p.label),
      h('span', { class: 'quill-price' }, `$${p.price}`),
      h('span', { class: 'muted small' }, `${p.days} day${p.days === 1 ? '' : 's'} of ${QUILL_NAME}`),
      btn);
  }));
}

const statusLine = (st: QuillStatusDTO) => st.active && st.until
  ? h('p', { class: 'quill-status on' }, '🪶 Active until ', h('strong', {}, when(st.until)), ` (${timeLeft(st.until)}). More passes add time.`)
  : h('p', { class: 'quill-status' }, st.until ? `Your last pass ended ${when(st.until)}.` : `You don't have a ${QUILL_NAME} pass yet.`);

/** /gold-quill: what it is, and the three passes. */
export async function viewGoldQuill() {
  page(QUILL_NAME, h('p', { class: 'muted' }, 'Loading…'));
  const st = await api<QuillStatusDTO>('/api/quill');
  const q = new URLSearchParams(location.search);
  page(QUILL_NAME,
    q.get('from') === 'views' ? h('p', { class: 'notice' }, `👁️ Views are a ${QUILL_NAME} perk.`) : null,
    q.get('cancelled') ? h('p', { class: 'notice' }, "Checkout cancelled. You haven't been charged.") : null,
    h('section', { class: 'card quill-hero' },
      h('div', { class: 'quill-ring-demo', 'aria-hidden': 'true' }, '🪶'),
      h('h1', {}, QUILL_NAME),
      h('p', {}, 'Support RoleplayRetro and unlock extras. One-time passes; nothing auto-renews.'),
      statusLine(st)),
    card('What you get', h('ul', { class: 'quill-perks' }, ...QUILL_PERKS.map((p) =>
      h('li', {}, h('span', { class: 'quill-perk-icon', 'aria-hidden': 'true' }, p.icon), h('span', {}, h('strong', {}, p.title), h('span', { class: 'muted small block' }, p.text)))))),
    card('Choose a pass', passCards(st),
      h('p', { class: 'muted small' }, 'US dollars, paid on PayPal. We never see your payment details. ',
        h('a', { href: '/terms#passes', target: '_blank', rel: 'noopener' }, 'Pass terms'), '.'),
      st.sandbox && st.available ? h('p', { class: 'notice small' }, '🧪 Test mode: no real money.') : null));
}

/** Back from PayPal: finish the purchase. */
export async function viewQuillReturn() {
  const orderId = new URLSearchParams(location.search).get('token') ?? '';
  page(QUILL_NAME, card(null, h('p', { class: 'muted' }, 'Finishing your purchase with PayPal…')));
  if (!/^[A-Z0-9]{5,40}$/.test(orderId)) return navigate('/gold-quill', true);
  try {
    const r = await api<QuillStatusDTO & { ok: boolean; pending?: boolean; message?: string }>('/api/quill/capture', { body: { orderId } });
    if (r.ok) {
      state.me = await api<MeDTO>('/api/me');
      page(QUILL_NAME,
        h('section', { class: 'card quill-hero' },
          h('div', { class: 'quill-ring-demo', 'aria-hidden': 'true' }, '🪶'),
          h('h1', {}, `Welcome to ${QUILL_NAME}!`),
          h('p', {}, 'Thank you for supporting RoleplayRetro.'),
          statusLine(r)),
        card('Try your perks',
          h('div', { class: 'stack' },
            h('a', { href: '/profile-views', class: 'button primary wide' }, '👁️ See who viewed your profile'),
            h('a', { href: '/edit-profile?tab=profile', class: 'button quiet wide' }, '🖼️ Pick an exclusive profile theme'),
            h('a', { href: '/settings?tab=subscriptions', class: 'button quiet wide' }, 'Subscriptions and receipts'))));
      history.replaceState({}, '', '/gold-quill');
    } else {
      page(QUILL_NAME, card(null, h('p', { class: r.pending ? 'notice' : 'notice error' }, r.message ?? 'The payment did not go through.'),
        h('a', { href: '/gold-quill', class: 'button quiet wide' }, 'Back to Gold Quill')));
    }
  } catch (e) {
    page(QUILL_NAME, card(null, h('p', { class: 'notice error' }, (e as Error).message),
      h('p', { class: 'muted small' }, 'If you were charged, check Settings › Subscriptions.'),
      h('a', { href: '/settings?tab=subscriptions', class: 'button quiet wide' }, 'Settings › Subscriptions')));
  }
}

/** Settings › Subscriptions. */
export async function subscriptionsCard(badgeToggle: HTMLElement): Promise<HTMLElement> {
  let st: QuillStatusDTO;
  try { st = await api<QuillStatusDTO>('/api/quill'); } catch (e) { return card('Subscriptions', h('p', { class: 'muted' }, (e as Error).message)); }
  const rows = st.history.map((o) => {
    const pass = QUILL_PASS_BY_ID.get(o.pass);
    const check = o.status === 'pending'
      ? h('button', { type: 'button', class: 'quiet', onclick: (async () => {
          try {
            const r = await api<{ ok: boolean; message?: string }>('/api/quill/capture', { body: { orderId: o.orderId } });
            if (r.ok) { state.me = await api<MeDTO>('/api/me'); toast('Payment cleared: your pass is active.'); navigate('/settings?tab=subscriptions', true); }
            else toast(r.message ?? 'Still processing.', true);
          } catch (e) { toast((e as Error).message, true); }
        }) as EventListener }, 'Check again')
      : null;
    return h('li', { class: 'receipt' },
      h('span', {}, h('strong', {}, `${QUILL_NAME} ${pass?.label ?? o.pass}`), ` · $${o.amount}`,
        h('span', { class: 'muted small block' }, `${when(o.date)} · ${o.status === 'pending' ? 'Pending at PayPal' : 'Paid'} · PayPal order ${o.orderId}`)),
      check);
  });
  return card('Subscriptions',
    h('div', { class: 'quill-sub-head' }, h('span', { class: 'quill-ring-demo small', 'aria-hidden': 'true' }, '🪶'), h('strong', {}, QUILL_NAME)),
    statusLine(st),
    h('a', { href: '/gold-quill', class: `button ${st.active ? 'quiet' : 'primary'} wide` }, st.active ? 'Add more time' : `Get ${QUILL_NAME}`),
    h('p', { class: 'muted small' }, 'Passes end on their own; nothing to cancel.'),
    st.active ? badgeToggle : null,
    h('h3', {}, 'Purchase history'),
    rows.length ? h('ul', { class: 'people receipts' }, ...rows) : h('p', { class: 'muted small' }, 'No purchases yet.'));
}
