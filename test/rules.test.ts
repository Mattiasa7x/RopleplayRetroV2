import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, MEMBER_ROOMS, RETAINED_PER_ROOM, SITE_NAME, SITE_ROOMS } from '../shared/config.js';
import { readFileSync } from 'node:fs';
import { strikeAction } from '../server/safety/strike-rules.js';
import { checkBody, cleanBody, extractMentions, visibleLength } from '../shared/text.js';
import { paginate } from '../server/paging.js';
import { containsBlocked, containsLink, floodKey, isShouting, parseBlocklist } from '../server/safety/filter.js';

test('chat limits: 420 chars, 10 per page, 20 pages, 200 retained', () => {
  assert.equal(CHAT.MAX_CHARS, 420);
  assert.equal(CHAT.PAGE_SIZE, 10);
  assert.equal(CHAT.MAX_PAGES, 20);
  assert.equal(RETAINED_PER_ROOM, 200);
});

test('length counts visible characters, not code units', () => {
  assert.equal(visibleLength('hello'), 5);
  assert.equal(visibleLength('👍🏽'), 1);
  assert.equal(visibleLength('👨‍👩‍👧'), 1); // joiner kept by cleanBody
  assert.equal(visibleLength(cleanBody('👨‍👩‍👧')), 1);
  assert.equal(visibleLength('é'), 1);
});

test('exactly 420 passes, 421 fails, blank fails', () => {
  assert.equal(checkBody('a'.repeat(420)).ok, true);
  const long = checkBody('a'.repeat(421));
  assert.equal(long.ok, false);
  assert.equal(!long.ok && long.code, 'too_long');
  assert.equal(checkBody('😀'.repeat(420)).ok, true);
  const blank = checkBody('   \n\t ');
  assert.equal(!blank.ok && blank.code, 'empty');
});

test('cleanBody removes hidden characters and line breaks', () => {
  assert.equal(cleanBody('hi​there\n\nfriend  !'), 'hithere friend !');
  assert.equal(cleanBody('‮evil'), 'evil');
});

test('mentions are unique and case-insensitive', () => {
  assert.deepEqual(extractMentions('@Sam hi @sam and @jo_99, email a@b.com'), ['sam', 'jo_99']);
});

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(n - i) })); // newest first

test('page 1 is the newest ten, oldest first within the page', () => {
  const p = paginate(rows(200));
  assert.equal(p.page, 1);
  assert.equal(p.totalPages, 20);
  assert.deepEqual(p.items.map((m) => m.id), ['191', '192', '193', '194', '195', '196', '197', '198', '199', '200']);
  assert.equal(p.newerCursor, null);
  assert.equal(p.olderCursor, '191');
});

test('walking older reaches page 20 and stops', () => {
  const all = rows(200);
  let p = paginate(all);
  let pages = 1;
  while (p.olderCursor) {
    p = paginate(all, { before: p.olderCursor });
    pages++;
  }
  assert.equal(pages, 20);
  assert.equal(p.page, 20);
  assert.deepEqual(p.items[0], { id: '1' });
});

test('newer cursor returns to the following page without overlap', () => {
  const all = rows(200);
  const p2 = paginate(all, { before: paginate(all).olderCursor! });
  const p3 = paginate(all, { before: p2.olderCursor! });
  const back = paginate(all, { after: p3.newerCursor! });
  assert.deepEqual(back.items, p2.items);
});

test('messages arriving while reading old pages do not shift them', () => {
  const before = rows(200);
  const p2 = paginate(before, { before: paginate(before).olderCursor! });
  const withNew = [{ id: '202' }, { id: '201' }, ...before];
  const p3a = paginate(before, { before: p2.olderCursor! });
  const p3b = paginate(withNew, { before: p2.olderCursor! });
  assert.deepEqual(p3a.items, p3b.items);
});

test('empty room gives one empty page', () => {
  const p = paginate([]);
  assert.equal(p.totalPages, 1);
  assert.deepEqual(p.items, []);
  assert.equal(p.olderCursor, null);
});

const list = parseBlocklist('# comment\nbadword\nspamword*\n');

test('blocklist catches common dodges', () => {
  for (const s of ['badword', 'BADWORD!', 'b4dw0rd', 'baaadwooord', 'b a d w o r d', 'b.a.d.w.o.r.d', 'bаdword' /* Cyrillic а */, 'bádword', 'spamwords']) {
    assert.equal(containsBlocked(s, list), true, s);
  }
});

test('blocklist leaves innocent text alone', () => {
  for (const s of ['bad words are bad', 'a word', 'hello there', 'I am 21']) {
    assert.equal(containsBlocked(s, list), false, s);
  }
});

test('link detection', () => {
  for (const s of ['https://x.y/z', 'go to www.site.test', 'visit spam.com now', 'spam dot com', 'spam (dot) com', 'spam[dot]com']) {
    const expected = !s.includes(' dot ');
    assert.equal(containsLink(s), expected, s);
  }
  assert.equal(containsLink('see you at 5.30'), false);
});

test('shouting check needs enough letters', () => {
  assert.equal(isShouting('LOL', 20, 0.7), false);
  assert.equal(isShouting('WHY IS EVERYONE IGNORING ME IN HERE', 20, 0.7), true);
  assert.equal(isShouting('Why is everyone ignoring me in here', 20, 0.7), false);
});

test('flood key ignores spacing, case and punctuation', () => {
  assert.equal(floodKey('Hello   THERE!!!'), floodKey('hello there'));
});

test('site name and room pools', () => {
  assert.equal(SITE_NAME, 'RoleplayRetro');
  assert.equal(SITE_ROOMS.count, 20);
  const seeded = readFileSync('server/db/seed.sql', 'utf8').match(/^\s*\('[a-z0-9-]+',/gm) ?? [];
  assert.equal(seeded.length, 20, 'seed.sql must define exactly 20 site rooms');
  assert.ok(MEMBER_ROOMS.maxOwnedPerUser >= 1);
});

test('strikes: 3 in the window mutes in the room, 6 in an hour mutes site-wide', () => {
  assert.equal(strikeAction(1, 1), 'none');
  assert.equal(strikeAction(2, 5), 'none');
  assert.equal(strikeAction(3, 3), 'room_mute');
  assert.equal(strikeAction(2, 6), 'site_mute');
  assert.equal(strikeAction(6, 6), 'site_mute');
});
