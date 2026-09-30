import { meIsQuill } from './quill.js';
import { INACTIVITY, MEMBER_ROOMS, Trust } from '../../../shared/config.js';
import type { RoomDetail, RoomImageDTO, RoomSanctionDTO, RoomSummary } from '../../../shared/types.js';
import { card, field, form, navigate, page, state, toast } from '../core.js';
import { api, h } from '../dom.js';
import { pagedGrid } from './pagedgrid.js';

/** Colour art used until (or instead of) a room picture, keyed by category. */
const ART: Record<string, string> = {
  'Start here': 'art-start', 'Out of character': 'art-ooc', Fantasy: 'art-fantasy', 'Sci-fi': 'art-scifi',
  Genre: 'art-genre', Hangouts: 'art-hangout', Regional: 'art-regional',
};

/** A picture tile for a room: its photo, name, and how many people are in it. */
export function roomTile(r: RoomSummary, opts: { big?: boolean } = {}): HTMLElement {
  const me = state.me!;
  const locked = me.trust < r.minTrustToPost;
  return h('li', {},
    h('a', { href: `/room/${r.slug}`, class: `room-tile ${ART[r.category] ?? 'art-member'}${opts.big ? ' big' : ''}` },
      r.image ? h('img', { src: r.image, alt: '', loading: 'lazy', decoding: 'async' }) : null,
      h('span', { class: 'tile-top' },
        r.unreadMentions ? h('span', { class: 'badge' }, `@${r.unreadMentions}`) : null,
        r.whitelistOnly ? h('span', { class: 'tile-tag' }, 'invite-only') : null,
        h('span', { class: `user-count${r.online ? ' live' : ''}`, 'aria-label': `${r.online} ${r.online === 1 ? 'person' : 'people'} here` },
          h('span', { class: 'dot-live', 'aria-hidden': 'true' }), String(r.online))),
      h('span', { class: 'tile-text' },
        h('span', { class: 'tile-name' }, r.favorite ? '★ ' : '', r.name),
        h('span', { class: 'tile-sub' },
          r.kind === 'member' ? (r.isOwner ? 'Your room' : `by ${r.ownerHandle ?? 'a member'}`) : r.description ?? '',
          locked ? ' · read only' : ''))));
}

const tiles = (list: RoomSummary[]) => h('ul', { class: 'room-tiles' }, ...list.map((r) => roomTile(r)));

const REGIONAL = 'Regional';

/** "3 rooms · 5 here" for a group of rooms. */
function groupMeta(list: RoomSummary[]): HTMLElement {
  const people = list.reduce((n, r) => n + r.online, 0);
  return h('span', { class: 'region-meta' }, `${list.length} room${list.length === 1 ? '' : 's'} · `,
    h('span', { class: people ? 'live-text' : '' }, `${people} here`));
}

/**
 * Regional rooms, one dropdown per part of the world (and a nested one per sub-region if a
 * region has them), so the list stays short until you open the part you want.
 */
function regionalPane(list: RoomSummary[]): HTMLElement {
  const groups = new Map<string, RoomSummary[]>();
  for (const r of list) {
    const key = r.region ?? 'Elsewhere';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const section = (name: string, rooms: RoomSummary[], nested = false): HTMLElement => {
    const subs = new Map<string, RoomSummary[]>();
    const direct: RoomSummary[] = [];
    for (const r of rooms) {
      if (!nested && r.subregion) subs.set(r.subregion, [...(subs.get(r.subregion) ?? []), r]);
      else direct.push(r);
    }
    return h('details', { class: `region-group${nested ? ' nested' : ''}` },
      h('summary', {}, h('span', { class: 'region-name' }, name), groupMeta(rooms)),
      h('div', { class: 'region-body' },
        direct.length ? tiles(direct) : null,
        ...[...subs].map(([sub, rs]) => section(sub, rs, true))));
  };
  return h('div', { class: 'regions' },
    h('p', { class: 'muted small' }, 'Tap a region to see its rooms.'),
    ...[...groups].map(([name, rooms]) => section(name, rooms)));
}

/** Theme tabs, in the order the site rooms were planned. Member rooms get their own tab. */
const THEME_ORDER = ['Start here', 'Out of character', 'Fantasy', 'Sci-fi', 'Genre', 'Hangouts', REGIONAL];
const TAB_LABEL: Record<string, string> = { 'Start here': 'Start Here', 'Out of character': 'Out of Character', 'Sci-fi': 'Sci-Fi' };
const tabId = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export async function viewRooms() {
  page('Rooms', h('p', { class: 'muted' }, 'Loading rooms…'));
  const rooms = await api<RoomSummary[]>('/api/rooms');
  const me = state.me!;
  const verified = me.trust >= Trust.Verified;
  const byCat = new Map<string, RoomSummary[]>();
  for (const r of rooms.filter((x) => x.kind === 'site')) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  const cats = [...byCat.keys()].sort((x, y) => (THEME_ORDER.indexOf(x) + 1 || 99) - (THEME_ORDER.indexOf(y) + 1 || 99));
  const member = rooms.filter((r) => r.kind === 'member').sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  const favs = rooms.filter((r) => r.favorite);

  const tabs: [string, string, HTMLElement, RoomSummary[]][] = [];
  if (favs.length) tabs.push(['favorites', '★ Favorites', tiles(favs), favs]);
  for (const c of cats) tabs.push([tabId(c), TAB_LABEL[c] ?? c, c === REGIONAL ? regionalPane(byCat.get(c)!) : tiles(byCat.get(c)!), byCat.get(c)!]);
  tabs.push(['member-realms', 'Member Realms', verified
    ? h('div', { class: 'stack' },
        member.length ? tiles(member) : h('p', { class: 'muted' }, 'No member realms yet. Start one!'),
        h('a', { href: '/new-room', class: 'button primary wide' }, '+ Create a room'))
    : h('p', { class: 'muted' }, 'Member realms are for verified members. ', h('a', { href: '/verify' }, 'Confirm your email'), ' to see, join and create them.'), member]);

  const wanted = new URLSearchParams(location.search).get('tab');
  // Every theme is visible at once as a list of buttons: nothing hidden off to the side.
  const buttons = tabs.map(([id, label, , list]) => {
    const people = list.reduce((n, r) => n + r.online, 0);
    const b = h('button', { type: 'button', role: 'tab', id: `rt-${id}`, class: 'theme-btn', 'aria-controls': `rp-${id}` },
      h('span', { class: 'theme-btn-name' }, label),
      h('span', { class: 'theme-btn-meta' }, `${list.length} room${list.length === 1 ? '' : 's'} · `,
        h('span', { class: people ? 'live-text' : '' }, `${people} here`)));
    b.addEventListener('click', () => show(id, true));
    return b;
  });
  const panes = tabs.map(([id, , el]) => h('div', { role: 'tabpanel', id: `rp-${id}`, 'aria-labelledby': `rt-${id}` }, el));
  function show(id: string, scroll = false) {
    tabs.forEach(([tid], i) => {
      const on = tid === id;
      buttons[i].classList.toggle('active', on);
      buttons[i].setAttribute('aria-selected', String(on));
      panes[i].hidden = !on;
      if (on && scroll) panes[i].scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    history.replaceState({}, '', `/rooms?tab=${id}`);
  }
  const bar = h('div', { class: 'theme-list', role: 'tablist', 'aria-label': 'Room themes' }, ...buttons);

  page('Rooms',
    !verified ? h('p', { class: 'notice' }, 'Confirm your email to chat everywhere. ', h('a', { href: '/verify' }, 'Enter code')) : null,
    bar,
    ...panes,
    h('p', { class: 'muted small center' }, 'Site rooms are auto-moderated: no links, repeat offenders are muted.'));
  const start = tabs.some(([id]) => id === wanted) ? wanted! : tabs[0][0];
  show(start);
}

/** The room's active kicks, mutes and bans, with a Lift button (the server decides who may lift which). */
async function bansCard(path: string, reload: () => void): Promise<HTMLElement> {
  let list: RoomSanctionDTO[] = [];
  try { list = await api<RoomSanctionDTO[]>(`${path}/sanctions`); } catch (e) { return card('Bans and mutes', h('p', { class: 'muted' }, (e as Error).message)); }
  const until = (s: RoomSanctionDTO) => s.expiresAt ? `until ${new Date(s.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'until lifted';
  const label = { ban: 'Banned', mute: 'Muted', kick: 'Kicked' } as const;
  return card(`Bans and mutes (${list.length})`,
    h('ul', { class: 'people' }, ...(list.length
      ? list.map((s) => h('li', { class: 'team-row' },
          h('span', {}, h('a', { href: `/profile/${s.handle}` }, s.handle),
            h('span', { class: 'muted small block' }, `${label[s.kind]} ${until(s)}${s.issuedBy ? ` · by ${s.issuedBy}` : ''}`)),
          h('button', { type: 'button', class: 'quiet', onclick: (async () => {
            try { await api(`/api/mod/sanctions/${s.id}/revoke`, { body: {} }); toast('Lifted.'); reload(); } catch (x) { toast((x as Error).message, true); }
          }) as EventListener }, 'Lift')))
      : [h('li', { class: 'muted' }, 'Nobody is banned or muted here.')])));
}

/** Pick a picture for a member room from the shared pool. Value is the chosen id, or '' for none. */
async function imagePicker(current: number | null): Promise<{ el: HTMLElement; value: () => number | null }> {
  let pool: RoomImageDTO[] = [];
  try { pool = await api<RoomImageDTO[]>('/api/room-images'); } catch { /* pictures optional */ }
  let chosen: number | null = current;
  const buttons: HTMLButtonElement[] = [];
  const paint = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.id) === (chosen ?? 0))));
  const pick = (id: number | null) => { chosen = id; paint(); };
  const none = h('button', { type: 'button', class: 'pick none', 'data-id': '0', 'aria-label': 'No picture' }, 'None');
  none.addEventListener('click', () => pick(null));
  buttons.push(none);
  const member = meIsQuill();
  for (const img of pool) {
    const locked = !!img.quill && !member;
    const b = h('button', { type: 'button', class: `pick${img.quill ? ' quill-pick' : ''}`, 'data-id': String(img.id), 'aria-label': locked ? `${img.title} (Gold Quill members only)` : img.title, title: img.credit ? `${img.title} · photo by ${img.credit}` : img.title },
      h('img', { src: img.thumb, alt: '', loading: 'lazy' }),
      img.quill ? h('span', { class: 'quill-tag' }, locked ? '🔒' : '🪶') : null);
    b.addEventListener('click', () => { if (locked) { toast('That picture is for Gold Quill members.', true); return; } pick(img.id); });
    buttons.push(b);
  }
  paint();
  const el = h('div', { class: 'field' },
    h('span', {}, 'Room picture'),
    pool.length ? pagedGrid(buttons, { className: 'picker', label: 'Room pictures', startIndex: Math.max(0, buttons.findIndex((b) => Number(b.dataset.id) === (current ?? 0))) }) : h('p', { class: 'muted small' }, 'Pictures are still loading. Pick one later in Manage.'),
    pool.length ? h('span', { class: 'muted small' }, 'Photos from Unsplash, free to use.') : null);
  return { el, value: () => chosen };
}

const checkbox = (label: string, name: string, checked = false) =>
  h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked }), h('span', {}, label));

export async function viewNewRoom() {
  if (state.me!.trust < Trust.Verified) {
    state.flash = 'Confirm your email to create member rooms.';
    return navigate('/verify', true);
  }
  const picker = await imagePicker(null);
  page('New room',
    card(null,
      h('p', { class: 'muted small' }, `Up to ${MEMBER_ROOMS.maxOwnedPerUser} rooms. Rooms close after ${INACTIVITY.roomDays} days without messages.`),
      form([
        field('Room name', 'name', 'text', { minlength: MEMBER_ROOMS.nameMin, maxlength: MEMBER_ROOMS.nameMax }),
        field('Description (optional)', 'description', 'text', { maxlength: MEMBER_ROOMS.descriptionMax, required: false }),
        checkbox('Invite-only: only people on my list can see and enter', 'whitelistOnly'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'chatFilter', checked: true }),
      h('span', {}, h('strong', {}, 'Chat filter'), h('span', { class: 'muted small block' }, "On: swear words can't be sent here."))),
        picker.el,
      ], 'Create room', async (d) => {
        const room = await api<RoomDetail>('/api/rooms', {
          body: { name: d.get('name'), description: String(d.get('description') ?? ''), whitelistOnly: d.get('whitelistOnly') === 'on', chatFilter: d.get('chatFilter') === 'on', imageId: picker.value() },
        });
        state.flash = room.whitelistOnly ? 'Room created. Add people to the invite list.' : 'Room created.';
        navigate(room.whitelistOnly ? `/room/${room.slug}/manage` : `/room/${room.slug}`);
      })));
}

export async function viewManage(slug: string) {
  let room: RoomDetail;
  try {
    room = await api<RoomDetail>(`/api/rooms/${encodeURIComponent(slug)}`);
  } catch (e) {
    state.flash = (e as Error).message;
    return navigate('/rooms', true);
  }
  const reload = () => void viewManage(slug);
  const path = `/api/rooms/${encodeURIComponent(slug)}`;
  // Moderators and operators (and staff) get just the Bans and mutes list; settings are the owner's.
  if (!room.canManage) {
    if (!room.canModerate) return navigate(`/room/${slug}`, true);
    page(`Manage ${room.name}`, h('a', { href: `/room/${slug}`, class: 'back' }, '‹ Back to room'), await bansCard(path, reload));
    return;
  }
  const site = room.kind === 'site';
  const picker = await imagePicker(room.imageId);

  const settings = form([
    site
      ? field('Room name', 'name', 'text', { value: room.name, minlength: MEMBER_ROOMS.nameMin, maxlength: MEMBER_ROOMS.nameMax })
      : h('div', { class: 'setting locked-row' },
          h('div', {}, h('span', { class: 'setting-label' }, 'Room name'), h('span', { class: 'muted small block' }, "Can't be changed.")),
          h('div', { class: 'locked-value' }, h('span', {}, room.name), h('span', { class: 'tag' }, 'Locked'))),
    field('Description', 'description', 'text', { value: room.description ?? '', maxlength: MEMBER_ROOMS.descriptionMax, required: false }),
    site ? null : checkbox('Invite-only (people not on the list are removed right away)', 'whitelistOnly', room.whitelistOnly),
    site ? null : h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'chatFilter', checked: room.chatFilter }),
      h('span', {}, h('strong', {}, 'Chat filter'), h('span', { class: 'muted small block' }, "On: swear words can't be sent here."))),
    site ? null : h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'readOnly', checked: room.readOnly }),
      h('span', {}, h('strong', {}, 'Read-only'), h('span', { class: 'muted small block' }, 'Only you and people you allow can chat. Pick them in the room\'s People list.'))),
    h('label', { class: 'field' }, h('span', {}, 'Slow mode'),
      h('select', { name: 'slow' }, ...[0, 5, 10, 30, 60].map((s) => h('option', { value: s, selected: s === room.slowModeSeconds }, s ? `One message every ${s} seconds` : 'Off')))),
    picker.el,
  ], 'Save', async (d) => {
    await api(path, { method: 'PATCH', body: {
      ...(site ? { name: d.get('name') } : { whitelistOnly: d.get('whitelistOnly') === 'on', chatFilter: d.get('chatFilter') === 'on', readOnly: d.get('readOnly') === 'on' }),
      description: String(d.get('description') ?? ''), slowModeSeconds: Number(d.get('slow')),
      imageId: picker.value(),
    } });
    toast('Saved.');
    reload();
  });

  const list = h('ul', { class: 'people' }, ...(room.whitelist?.length
    ? room.whitelist.map((handle) => h('li', {}, h('a', { href: `/profile/${handle}` }, handle),
        h('button', { type: 'button', class: 'quiet', onclick: (async () => {
          try { await api(`${path}/whitelist/${encodeURIComponent(handle)}`, { method: 'DELETE' }); reload(); } catch (e) { toast((e as Error).message, true); }
        }) as EventListener }, 'Remove')))
    : [h('li', { class: 'muted' }, 'Nobody yet.')]));

  const add = form([field('Add a verified member by name', 'handle', 'text', { maxlength: 16, autocapitalize: 'off' })], 'Add to list', async (d, err) => {
    try { await api(`${path}/whitelist/${encodeURIComponent(String(d.get('handle')).trim())}`, { method: 'PUT', body: {} }); reload(); }
    catch (x) { err((x as Error).message); }
  });

  // ----- room team: moderators and operators -----
  const team = room.team ?? [];
  const teamList = h('ul', { class: 'people' }, ...(team.length
    ? team.map((t) => h('li', { class: 'team-row' },
        h('a', { href: `/profile/${t.handle}` }, t.handle),
        h('select', { 'aria-label': `Role for ${t.handle}`, onchange: (async (e: Event) => {
          try { await api(`${path}/roles/${encodeURIComponent(t.handle)}`, { method: 'PUT', body: { role: (e.target as HTMLSelectElement).value } }); toast('Role changed.'); reload(); }
          catch (x) { toast((x as Error).message, true); }
        }) as EventListener },
          h('option', { value: 'moderator', selected: t.role === 'moderator' }, 'Moderator'),
          h('option', { value: 'operator', selected: t.role === 'operator' }, 'Operator')),
        h('button', { type: 'button', class: 'quiet', onclick: (async () => {
          try { await api(`${path}/roles/${encodeURIComponent(t.handle)}`, { method: 'DELETE' }); reload(); } catch (x) { toast((x as Error).message, true); }
        }) as EventListener }, 'Remove')))
    : [h('li', { class: 'muted' }, 'No moderators or operators yet.')]));
  const addTeam = form([
    field('Add someone by name', 'handle', 'text', { maxlength: 16, autocapitalize: 'off' }),
    h('label', { class: 'field' }, h('span', {}, 'As'),
      h('select', { name: 'role' }, h('option', { value: 'moderator' }, 'Moderator'), h('option', { value: 'operator', selected: true }, 'Operator'))),
  ], 'Add to team', async (d, err) => {
    try { await api(`${path}/roles/${encodeURIComponent(String(d.get('handle')).trim())}`, { method: 'PUT', body: { role: d.get('role') } }); reload(); }
    catch (x) { err((x as Error).message); }
  });

  page(`Manage ${room.name}`,
    h('a', { href: `/room/${slug}`, class: 'back' }, '‹ Back to room'),
    card('Room settings', site ? null : h('p', { class: 'muted small' }, `Closes automatically after ${INACTIVITY.roomDays} days without messages.`), settings),
    site ? null : card(`Room team (${team.length})`,
      h('ul', { class: 'team-help' },
        h('li', {}, h('span', { class: 'role-badge owner' }, 'Owner'), ' You. Your team can\'t act on you.'),
        h('li', {}, h('span', { class: 'role-badge moderator' }, 'Mod'), ' Kick, mute or ban anyone but you.'),
        h('li', {}, h('span', { class: 'role-badge operator' }, 'Op'), ' Kick, mute or ban regular members.')),
      h('p', { class: 'muted small' }, 'Badges show in this room only.'),
      teamList, addTeam),
    site ? null : await bansCard(path, reload),
    site ? null : card(`Invite list (${room.whitelist?.length ?? 0})`,
      h('p', { class: 'muted small' }, room.whitelistOnly ? 'Only these members and you can enter.' : 'Applies when invite-only is on.'),
      list, add),
    site ? null : card('Delete room',
      h('button', { type: 'button', class: 'danger wide', onclick: (async () => {
        if (!confirm(`Delete "${room.name}" and all its messages? This can't be undone.`)) return;
        try { await api(path, { method: 'DELETE' }); state.flash = 'Room deleted.'; navigate('/rooms'); } catch (e) { toast((e as Error).message, true); }
      }) as EventListener }, 'Delete this room')));
}
