// Usage: npm run make-admin -- <handle>
import { Trust } from '../shared/config.js';
import { audit, db } from '../server/store.js';

const handle = process.argv[2];
if (!handle) {
  console.error('Usage: npm run make-admin -- <handle>');
  process.exit(1);
}
const { rows } = await db.query<{ id: string }>(
  'UPDATE users SET trust_level = $2, email_verified_at = COALESCE(email_verified_at, now()) WHERE lower(handle) = lower($1) RETURNING id',
  [handle, Trust.Admin],
);
if (!rows[0]) {
  console.error(`No user with handle "${handle}". Sign up in the app first.`);
  process.exit(1);
}
await audit(db, null, 'make_admin_cli', 'user', rows[0].id);
console.log(`${handle} is now an admin.`);
await db.end();
process.exit(0);
