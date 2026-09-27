// Creates tables (safe to re-run) and seeds the starter rooms.
import { readFileSync } from 'node:fs';
import { db } from '../server/store.js';

for (const file of ['server/db/schema.sql', 'server/db/seed.sql']) {
  await db.query(readFileSync(file, 'utf8'));
  console.log(`applied ${file}`);
}
await db.end();
process.exit(0);
