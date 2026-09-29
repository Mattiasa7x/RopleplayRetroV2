import { GIFT_BY_ID, GIFT_RULES, GIFT_THEMES, GIFTS } from '../../../shared/gifts.js';
import type { GiftAllowanceDTO, MyGiftsDTO, ProfileDTO, ProfileGiftsDTO } from '../../../shared/types.js';
import { card, navigate, page, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';
import { giftName, giftTile } from '../giftart.js';
import { reportContent } from './home.js';

const when = (a: GiftAllowanceDTO) => (a.nextAt ? new Date(a.nextAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const leftText = (a: GiftAllowanceDTO) =>
  a.left > 0 ? `${a.left} of ${a.limit} gifts left today` : `You've sent ${a.limit} gifts today. Next one frees up ${when(a)}.`;

/** Send a gift: pick a theme, pick a gift, add a message if you like. */
export async function viewSendGift(handle: string) {
  page('Send a gift', h('p', { class: 'muted' }, 'Loading…'));
  const [p, allow] = await Promise.all([
    api<ProfileDTO>(`/api/profiles/${encodeURIComponent(handle)}`),
    api<GiftAllowanceDTO>('/api/gifts/allowance'),
  ]);
  let a = allow;
  const back = h('a', { href: `/profile/${p.handle}`, class: 'back' }, `‹ ${p.handle}`);
  if (!p.canSendGift) {
    page('Send a gift', back, card(null, h('p', { class: 'muted' }, `You can't send gifts to ${p.handle}.`)));
    return;
  }
  let chosen: string | null = null;
  const status = h('p', { class: 'muted small gift-left', 'aria-live': 'polite' }, leftText(a));

  // selected gift + message + send
  const preview = h('div', { class: 'gift-preview' });
  const ta = h('textarea', { rows: 3, maxlength: GIFT_RULES.messageMax * 2, placeholder: 'Add a message (optional)', 'aria-label': 'Message (optional)' });
  const count = h('span', { class: 'counter' });
  const sendBtn = h('button', { type: 'button', class: 'primary wide' }, 'Send gift');
  const paint = () => {
    const left = GIFT_RULES.messageMax - [...ta.value.trim()].length;
    count.textContent = `${left} left`;
    count.className = 'counter' + (left < 0 ? ' over' : left <= 30 ? ' warn' : '');
    sendBtn.disabled = !chosen || left < 0 || a.left === 0;
    sendBtn.textContent = chosen ? `Send ${giftName(chosen)}` : 'Pick a gift above';
    preview.replaceChildren(...(chosen ? [giftTile(chosen, 'lg'), h('strong', {}, giftName(chosen))] : [h('span', { class: 'muted' }, 'No gift picked yet.')]));
  };
  ta.addEventListener('input', paint);
  sendBtn.addEventListener('click', async () => {
    if (!chosen) return;
    sendBtn.disabled = true;
    try {
      const r = await api<GiftAllowanceDTO>(`/api/profiles/${encodeURIComponent(p.handle)}/gifts`, { body: { gift: chosen, message: ta.value.trim() || undefined } });
      a = r;
      toast(`${giftName(chosen)} sent to ${p.handle}!`);
      navigate(`/profile/${p.handle}`);
    } catch (e) {
      toast((e as Error).message, true);
      paint();
    }
  });

  // themes as a two-column list (like the rooms page), each opening its 10 gifts
  const giftBtns = new Map<string, HTMLButtonElement>();
  const grids = GIFT_THEMES.map((t) => {
    const grid = h('div', { class: 'gift-grid', role: 'tabpanel', id: `gp-${t.id}` },
      ...GIFTS.filter((g) => g.theme === t.id).map((g) => {
        const b = h('button', { type: 'button', class: 'gift-choice', 'aria-pressed': 'false', 'aria-label': g.name }, giftTile(g.id, 'md'), h('span', { class: 'gift-choice-name' }, g.name));
        b.addEventListener('click', () => {
          chosen = g.id;
          giftBtns.forEach((x, id) => x.setAttribute('aria-pressed', String(id === chosen)));
          paint();
          composerCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        giftBtns.set(g.id, b);
        return b;
      }));
    return grid;
  });
  const tabBtns = GIFT_THEMES.map((t, i) => {
    const first = GIFTS.find((g) => g.theme === t.id)!;
    const b = h('button', { type: 'button', role: 'tab', class: 'theme-btn gift-theme-btn', 'aria-controls': `gp-${t.id}` },
      h('span', { class: 'gift-theme-emoji', 'aria-hidden': 'true' }, first.emoji), h('span', { class: 'theme-btn-name' }, t.name));
    b.addEventListener('click', () => show(i));
    return b;
  });
  function show(i: number) {
    tabBtns.forEach((b, j) => { b.setAttribute('aria-selected', String(i === j)); b.classList.toggle('active', i === j); grids[j].hidden = i !== j; });
  }
  const composerCard = card('Your gift', preview,
    h('label', { class: 'field' }, h('span', {}, 'Message'), ta, h('span', { class: 'row about-foot' }, h('span', { class: 'muted small' }, `Only ${p.handle} will see it.`), count)),
    sendBtn, status);
  page('Send a gift', back,
    card(`Send ${p.handle} a gift`,
      h('div', { class: 'theme-list gift-themes', role: 'tablist', 'aria-label': 'Gift themes' }, ...tabBtns),
      ...grids),
    composerCard);
  show(0);
  paint();
}

/** Your gifts: who sent what, their messages, and which one shows on your profile. */
export async function viewMyGifts(pageNo = 1) {
  page('Your gifts', h('p', { class: 'muted' }, 'Loading…'));
  const d = await api<MyGiftsDTO>(`/api/me/gifts?page=${pageNo}`);
  const me = state.me!;
  let shown = d.profileGiftId;
  const setBtns: HTMLButtonElement[] = [];
  const paintShown = () => setBtns.forEach((b) => {
    const on = b.dataset.id === shown;
    b.textContent = on ? 'On your profile ✓' : 'Show on profile';
    b.classList.toggle('primary', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const setShown = async (id: string | null) => {
    const before = shown;
    shown = id; paintShown();
    try { await api('/api/me/profile', { method: 'PATCH', body: { profileGift: id } }); toast(id ? 'Shown on your profile.' : 'Removed from your profile.'); }
    catch (e) { shown = before; paintShown(); toast((e as Error).message, true); }
  };
  const items = d.gifts.map((g) => {
    const setBtn = h('button', { type: 'button', class: 'quiet small-btn', 'data-id': g.id });
    setBtn.addEventListener('click', () => void setShown(shown === g.id ? null : g.id));
    setBtns.push(setBtn);
    const li = h('li', { class: 'gift-item' },
      giftTile(g.gift, 'md'),
      h('div', { class: 'gift-item-text' },
        h('strong', {}, giftName(g.gift)),
        h('span', { class: 'muted small' }, g.from ? h('span', {}, 'From ', h('a', { href: `/profile/${g.from.handle}` }, g.from.handle)) : 'From a former member', ` · ${timeAgo(g.createdAt)}`),
        g.message ? h('p', { class: 'gift-message' }, g.message) : null,
        h('div', { class: 'row wrap gift-actions' }, setBtn,
          h('button', { type: 'button', class: 'link', onclick: (async () => {
            try { await api(`/api/me/gifts/${g.id}`, { method: 'DELETE' }); li.remove(); if (shown === g.id) shown = null; toast('Gift removed.'); }
            catch (e) { toast((e as Error).message, true); }
          }) as EventListener }, 'Remove'),
          g.message && g.from ? h('button', { type: 'button', class: 'link', onclick: (() => void reportContent('gift', g.id)) as EventListener }, 'Report') : null)));
    return li;
  });
  paintShown();
  const pager = d.pages > 1
    ? h('div', { class: 'pager' },
        h('button', { type: 'button', class: 'quiet', disabled: d.page <= 1, onclick: (() => void viewMyGifts(d.page - 1)) as EventListener }, '‹ Newer'),
        h('span', { class: 'muted small' }, `Page ${d.page} of ${d.pages}`),
        h('button', { type: 'button', class: 'quiet', disabled: d.page >= d.pages, onclick: (() => void viewMyGifts(d.page + 1)) as EventListener }, 'Older ›'))
    : null;
  const vis = me.prefs.giftsVisibility;
  page('Your gifts',
    h('a', { href: `/profile/${me.handle}`, class: 'back' }, `‹ ${me.handle}`),
    card(`Gifts you've received (${d.total})`,
      h('p', { class: 'muted small' },
        vis === 'me' ? 'Only you can see your gifts. ' : vis === 'friends' ? 'Your friends can see which gifts you have. ' : 'Everyone can see which gifts you have. ',
        'Messages and who sent them are always private. ', h('a', { href: '/settings?tab=privacy' }, 'Change')),
      d.gifts.length ? h('ul', { class: 'gift-list' }, ...items) : h('p', { class: 'muted' }, 'No gifts yet.'),
      pager));
}

/** Someone else's gifts: just which gifts and how many, if they allow it. */
export async function viewProfileGifts(handle: string) {
  if (state.me && handle.toLowerCase() === state.me.handle.toLowerCase()) return viewMyGifts();
  page('Gifts', h('p', { class: 'muted' }, 'Loading…'));
  const d = await api<ProfileGiftsDTO>(`/api/profiles/${encodeURIComponent(handle)}/gifts`);
  const back = h('a', { href: `/profile/${d.handle}`, class: 'back' }, `‹ ${d.handle}`);
  if (!d.allowed) {
    page('Gifts', back, card(null, h('p', { class: 'muted' }, `${d.handle} keeps their gifts private.`)));
    return;
  }
  page('Gifts', back,
    card(`${d.handle}'s gifts (${d.total})`,
      d.gifts.length
        ? h('ul', { class: 'gift-collection' }, ...d.gifts.filter((g) => GIFT_BY_ID.has(g.gift)).map((g) =>
            h('li', {}, giftTile(g.gift, 'md'), h('span', { class: 'gift-choice-name' }, giftName(g.gift)), g.count > 1 ? h('span', { class: 'gift-count' }, `×${g.count}`) : null)))
        : h('p', { class: 'muted' }, 'No gifts yet.')));
}
