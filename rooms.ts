import { MEMBER_ROOMS, Trust } from '../../../shared/config.js';
import type { RoomDetail, RoomSummary } from '../../../shared/types.js';
import { card, field, form, navigate, page, state, toast } from '../core.js';
import { api, h } from '../dom.js';

function roomItem(r: RoomSummary): HTMLElement {
  const me = state.me!;
  const locked = me.trust < r.minTrustToPost;
  return h('li', {},
    h('a', { href: `/room/${r.slug}`, class: 'room-link' },
      h('span', { class: 'room-name' }, r.favorite ? '★ ' : '', r.name),
      h('span', { class: 'room-meta' },
        r.unreadMentions ? h('span', { class: 'badge' }, `@${r.unreadMentions}`) : null,
        r.whitelistOnly ? h('span', { class: 'tag' }, 'invite-only') : null,
        r.kind === 'member' ? h('span', { class: 'muted small' }, r.isOwner ? 'yours' : `by ${r.ownerHandle ?? 'a member'}`) : null,
        locked ? h('span', { class: 'muted small' }, 'read only') : null,
        h('span', { class: 'online-count', 'aria-label': `${r.online} people here` }, String(r.online)))));
}

export async function viewRooms() {
  page('Rooms', h('p', { class: 'muted' }, 'Loading rooms…'));
  const rooms = await api<RoomSummary[]>('/api/rooms');
  const me = state.me!;
  const verified = me.trust >= Trust.Verified;
  const byCat = new Map<string, RoomSummary[]>();
  for (const r of rooms.filter((x) => x.kind === 'site')) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  const member = rooms.filter((r) => r.kind === 'member');

  page('Rooms',
    !verified ? h('p', { class: 'notice' }, 'Until you confirm your email you can read every site room and chat in Newcomers and Help Desk. ', h('a', { href: '/verify' }, 'Enter code')) : null,
    card('Site rooms',
      h('p', { class: 'muted small' }, 'Official rooms, strictly auto-moderated: no links, and repeated rule-breaking earns an automatic mute.'),
      ...[...byCat].map(([cat, list]) => h('div', { class: 'room-group' }, h('h3', {}, cat), h('ul', { class: 'room-list' }, ...list.map(roomItem))))),
    card('Member rooms',
      verified
        ? h('div', {},
            member.length ? h('ul', { class: 'room-list' }, ...member.map(roomItem)) : h('p', { class: 'muted' }, 'No member rooms yet. Start one!'),
            h('a', { href: '/new-room', class: 'button primary wide' }, '+ Create a room'))
        : h('p', { class: 'muted' }, 'Member rooms are made and run by verified members. ', h('a', { href: '/verify' }, 'Confirm your email'), ' to see, join and create them.')));
}

const checkbox = (label: string, name: string, checked = false) =>
  h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked }), h('span', {}, label));

export function viewNewRoom() {
  if (state.me!.trust < Trust.Verified) {
    state.flash = 'Confirm your email to create member rooms.';
    return navigate('/verify', true);
  }
  page('New room',
    card(null,
      h('p', { class: 'muted small' }, `You can own up to ${MEMBER_ROOMS.maxOwnedPerUser} rooms. Only verified members can find or enter member rooms.`),
      form([
        field('Room name', 'name', 'text', { minlength: MEMBER_ROOMS.nameMin, maxlength: MEMBER_ROOMS.nameMax }),
        field('Description (optional)', 'description', 'text', { maxlength: MEMBER_ROOMS.descriptionMax, required: false }),
        checkbox('Invite-only: only people on my list can see and enter', 'whitelistOnly'),
      ], 'Create room', async (d) => {
        const room = await api<RoomDetail>('/api/rooms', {
          body: { name: d.get('name'), description: String(d.get('description') ?? ''), whitelistOnly: d.get('whitelistOnly') === 'on' },
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
  if (!room.canManage) return navigate(`/room/${slug}`, true);
  const reload = () => void viewManage(slug);
  const path = `/api/rooms/${encodeURIComponent(slug)}`;

  const settings = form([
    field('Room name', 'name', 'text', { value: room.name, minlength: MEMBER_ROOMS.nameMin, maxlength: MEMBER_ROOMS.nameMax }),
    field('Description', 'description', 'text', { value: room.description ?? '', maxlength: MEMBER_ROOMS.descriptionMax, required: false }),
    checkbox('Invite-only (people not on the list are removed right away)', 'whitelistOnly', room.whitelistOnly),
    h('label', { class: 'field' }, h('span', {}, 'Slow mode'),
      h('select', { name: 'slow' }, ...[0, 5, 10, 30, 60].map((s) => h('option', { value: s, selected: s === room.slowModeSeconds }, s ? `One message every ${s} seconds` : 'Off')))),
  ], 'Save', async (d) => {
    await api(path, { method: 'PATCH', body: {
      name: d.get('name'), description: String(d.get('description') ?? ''),
      whitelistOnly: d.get('whitelistOnly') === 'on', slowModeSeconds: Number(d.get('slow')),
    } });
    toast('Saved.');
    reload();
  });

  const list = h('ul', { class: 'people' }, ...(room.whitelist?.length
    ? room.whitelist.map((handle) => h('li', {}, h('a', { href: `/profile/${handle}` }, handle),
        h('button', { type: 'button', class: 'quiet', onclick: (async () => {
          try { await api(`${path}/whitelist/${encodeURIComponent(handle)}`, { method: 'DELETE' }); reload(); } catch (e) { toast((e as Error).message, true); }
        }) as EventListener }, 'Remove')))
    : [h('li', { class: 'muted' }, 'Nobody yet. You always have access as the owner.')]));

  const add = form([field('Add a verified member by name', 'handle', 'text', { maxlength: 16, autocapitalize: 'off' })], 'Add to list', async (d, err) => {
    try { await api(`${path}/whitelist/${encodeURIComponent(String(d.get('handle')).trim())}`, { method: 'PUT', body: {} }); reload(); }
    catch (x) { err((x as Error).message); }
  });

  page(`Manage ${room.name}`,
    h('a', { href: `/room/${slug}`, class: 'back' }, '‹ Back to room'),
    card('Room settings', settings),
    card(`Invite list (${room.whitelist?.length ?? 0})`,
      h('p', { class: 'muted small' }, room.whitelistOnly ? 'Only these members (and you) can see and enter this room.' : 'The room is open to all verified members; the list applies once invite-only is on.'),
      list, add),
    card('Delete room',
      h('button', { type: 'button', class: 'danger wide', onclick: (async () => {
        if (!confirm(`Delete "${room.name}" and all its messages? This can't be undone.`)) return;
        try { await api(path, { method: 'DELETE' }); state.flash = 'Room deleted.'; navigate('/rooms'); } catch (e) { toast((e as Error).message, true); }
      }) as EventListener }, 'Delete this room')));
}
