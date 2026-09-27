import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { handleSkeleton, isReservedHandle } from '../shared/handles.js';
import { ageOn, effectivePrefs, isMinor, lockedChanges } from '../server/account.js';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../server/totp.js';
import { parseBlocklist } from '../server/safety/filter.js';
import { maskWith } from '../server/safety/mature.js';

test('lookalike names share one skeleton', () => {
  const john = handleSkeleton('John');
  for (const h of ['JOHN', 'J0hn', 'jo_hn', 'john_', 'johnn', 'J0HN__']) assert.equal(handleSkeleton(h), john, h);
  assert.equal(handleSkeleton('m1ke'), handleSkeleton('rnike'));
  assert.equal(handleSkeleton('Iris'), handleSkeleton('l1ris'.replace('l1', 'I')));
  assert.equal(handleSkeleton('vvolf'), handleSkeleton('wolf'));
  assert.notEqual(handleSkeleton('Johnny'), john);
  assert.notEqual(handleSkeleton('mike'), handleSkeleton('make'));
});

test('staff and site names are reserved, ordinary words are not', () => {
  for (const h of ['Admin', 'adm1n_jo', 'Moderator7', 'mod', 'M0D', 'Official_Bob', 'RoleplayRetro', 'Support']) assert.equal(isReservedHandle(h), true, h);
  for (const h of ['model', 'modern', 'Jane_Doe', 'helpful_hank']) assert.equal(isReservedHandle(h), false, h);
});

test('database skeleton function matches the app exactly', { skip: !process.env.PGTEST && 'set PGTEST=1 with a local database to run' }, () => {
  const names = ['John', 'J0HN_', 'jo_hn', 'Iohn', 'm1ke', 'rnike', 'Anna', 'nightowl88', 'vvolf', 'x_x_x', 'Zz9_Top', 'Rn_Vv_Ii'];
  const sql = `SELECT string_agg(handle_skeleton(h), ',' ORDER BY o) FROM unnest(ARRAY['${names.join("','")}']) WITH ORDINALITY AS t(h, o)`;
  const out = execFileSync('psql', [process.env.DATABASE_URL ?? 'postgres://chat:chat@127.0.0.1/chat', '-At', '-c', sql]).toString().trim();
  assert.equal(out, names.map(handleSkeleton).join(','));
});

test('age and the under-18 locks', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  assert.equal(ageOn('2008-09-27', now), 18);
  assert.equal(ageOn('2008-09-28', now), 17);
  assert.equal(isMinor(null), true);
  const p = effectivePrefs({ chatFilter: false, profileVisibility: 'everyone', theme: 'dark' }, true);
  assert.equal(p.chatFilter, true);
  assert.equal(p.profileVisibility, 'friends');
  assert.equal(p.theme, 'dark');
  assert.equal(effectivePrefs({ chatFilter: false }, false).chatFilter, false);
  assert.deepEqual(lockedChanges({ chatFilter: false }, true), ['chatFilter']);
  assert.deepEqual(lockedChanges({ chatFilter: true, theme: 'light' }, true), []);
  assert.deepEqual(lockedChanges({ chatFilter: false }, false), []);
});

test('TOTP matches the RFC 6238 test vectors', () => {
  const key = Buffer.from('12345678901234567890');
  assert.equal(totp(key, 59_000, 8), '94287082');
  assert.equal(totp(key, 1111111109_000, 8), '07081804');
  assert.equal(totp(key, 2000000000_000, 8), '69279037');
  assert.equal(hotp(key, 0), '755224'); // RFC 4226
  const b32 = base32Encode(key);
  assert.deepEqual(base32Decode(b32), key);
  assert.equal(verifyTotp(b32, totp(key, 1_700_000_000_000), 1_700_000_000_000), true);
  assert.equal(verifyTotp(b32, totp(key, 1_700_000_030_000), 1_700_000_000_000), true); // one step of drift
  assert.equal(verifyTotp(b32, totp(key, 1_700_000_120_000), 1_700_000_000_000), false);
});

test('chat filter masks mature words but keeps the sentence', () => {
  const list = parseBlocklist('heck\ndarn*\n');
  assert.equal(maskWith('what the heck happened', list), 'what the h*** happened');
  assert.equal(maskWith('HECK! darned thing', list), 'H***! d***** thing');
  assert.equal(maskWith('h3ck no', list), 'h*** no');
  assert.equal(maskWith('check the deck', list), 'check the deck');
});
