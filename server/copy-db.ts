import pg from 'pg';
import { db, withoutChannelBinding } from './store.js';

/**
 * One-time move to a new database host. Set MIGRATE_FROM_URL to the old database and point
 * DATABASE_URL at the new one: on start, if the new database has no members yet, everything is
 * copied across in one transaction (all or nothing), and the counts are logged. Once it's done,
 * remove MIGRATE_FROM_URL. Runs after schema.sql, so both sides have the same tables.
 */

type Q = pg.ClientBase;
const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"';

/** Every value comes back as the text Postgres sent, so it goes back in exactly as it was. */
const raw = { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig;

async function tablesOf(q: Q): Promise<string[]> {
  const { rows } = await q.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`);
  return rows.map((r) => r.t);
}

/** Columns we can write: not generated. */
async function columnsOf(q: Q, table: string): Promise<{ name: string; nullable: boolean }[]> {
  // (as a number: the old database's rows come back as plain text)
  const { rows } = await q.query<{ name: string; nullable: string | number }>(
    `SELECT a.attname AS name, (NOT a.attnotnull)::int AS nullable FROM pg_attribute a
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY a.attnum`, ['public.' + ident(table)]);
  return rows.map((r) => ({ name: r.name, nullable: Number(r.nullable) === 1 }));
}

interface Fk { child: string; parent: string; cols: string[] }

async function foreignKeys(q: Q): Promise<Fk[]> {
  const { rows } = await q.query<{ child: string; parent: string; cols: string }>(
    `SELECT ch.relname AS child, pa.relname AS parent,
            array_to_json(ARRAY(SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = ANY(c.conkey)))::text AS cols
       FROM pg_constraint c JOIN pg_class ch ON ch.oid = c.conrelid JOIN pg_class pa ON pa.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = ch.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'`);
  return rows.map((r) => ({ child: r.child, parent: r.parent, cols: JSON.parse(r.cols) as string[] }));
}

/**
 * Order tables so each comes after the ones it points to. Self-references and loops
 * (users.invited_by, users.profile_gift_id → gifts → users) are broken by leaving those
 * columns empty on the first pass and filling them in afterwards.
 */
function plan(tables: string[], fks: Fk[], nullable: Map<string, Set<string>>, checked: Map<string, string>) {
  const deferred = new Map<string, Set<string>>(); // table → columns filled in later
  const defer = (fk: Fk) => {
    const s = deferred.get(fk.child) ?? new Set<string>();
    for (const c of fk.cols) s.add(c);
    deferred.set(fk.child, s);
  };
  const set = new Set(tables);
  let edges = fks.filter((f) => set.has(f.child) && set.has(f.parent));
  for (const f of edges.filter((f) => f.child === f.parent)) defer(f);
  edges = edges.filter((f) => f.child !== f.parent);

  const order: string[] = [];
  const left = new Set(tables);
  while (left.size) {
    const ready = [...left].filter((t) => !edges.some((e) => e.child === t && left.has(e.parent)));
    if (ready.length) {
      for (const t of ready.sort()) { order.push(t); left.delete(t); }
      continue;
    }
    // A loop: break it at a link whose columns can be empty for a moment.
    // Only a link that's actually part of a loop (its parent leads back to its child), whose
    // columns may be empty, preferring ones no CHECK rule looks at (rooms.owner_id is).
    const reaches = (from: string, to: string) => {
      const seen = new Set<string>([from]);
      const stack = [from];
      while (stack.length) {
        const t = stack.pop()!;
        if (t === to) return true;
        for (const e of edges) if (e.child === t && left.has(e.parent) && !seen.has(e.parent)) { seen.add(e.parent); stack.push(e.parent); }
      }
      return false;
    };
    const candidates = edges.filter((e) => left.has(e.child) && left.has(e.parent)
      && e.cols.every((c) => nullable.get(e.child)?.has(c)) && reaches(e.parent, e.child));
    const unchecked = (e: Fk) => !e.cols.some((c) => (checked.get(e.child) ?? '').includes(c));
    const cut = candidates.find(unchecked) ?? candidates[0];
    if (!cut) throw new Error(`can't order tables: ${[...left].join(', ')}`);
    defer(cut);
    edges = edges.filter((e) => e !== cut);
  }
  return { order, deferred };
}

export async function copyFromOldDatabase(log: (m: string) => void): Promise<void> {
  const from = process.env.MIGRATE_FROM_URL?.trim();
  if (!from) return;
  if (from === process.env.DATABASE_URL?.trim()) {
    log('database copy skipped: MIGRATE_FROM_URL is the same database as DATABASE_URL');
    return;
  }
  const { rows: has } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM (SELECT 1 FROM users LIMIT 1) x');
  if (Number(has[0].n) > 0) {
    log('database copy skipped: the new database already has members. You can remove MIGRATE_FROM_URL now.');
    return;
  }

  const src = new pg.Client({ connectionString: withoutChannelBinding(from), types: raw });
  await src.connect();
  const dst = await db.connect();
  const started = Date.now();
  try {
    await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // one consistent snapshot
    const srcTables = new Set(await tablesOf(src));
    const tables = (await tablesOf(dst)).filter((t) => srcTables.has(t));

    const cols = new Map<string, string[]>();
    const nullable = new Map<string, Set<string>>();
    for (const t of tables) {
      const have = new Set((await columnsOf(src, t)).map((c) => c.name));
      const mine = (await columnsOf(dst, t)).filter((c) => have.has(c.name));
      cols.set(t, mine.map((c) => c.name));
      nullable.set(t, new Set(mine.filter((c) => c.nullable).map((c) => c.name)));
    }
    const { rows: checks } = await dst.query<{ t: string; def: string }>(
      `SELECT c.conrelid::regclass::text AS t, string_agg(pg_get_constraintdef(c.oid), ' ') AS def
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'c' AND n.nspname = 'public' GROUP BY 1`);
    const checked = new Map(checks.map((r) => [r.t.replace(/"/g, ''), r.def]));
    const { order, deferred } = plan(tables, await foreignKeys(dst), nullable, checked);
    log(`database copy: ${order.length} tables; filled in afterwards: ${[...deferred].map(([t, c]) => `${t}.${[...c].join('/')}`).join(', ') || 'none'}`);

    await dst.query('BEGIN');
    // Our own triggers (handle rules, age rules, the admin rule, the audit lock) re-check things
    // the old data already passed; switch them off for the copy. Foreign keys still apply.
    for (const t of tables) await dst.query(`ALTER TABLE ${ident(t)} DISABLE TRIGGER USER`);
    await dst.query(`TRUNCATE ${tables.map(ident).join(', ')} RESTART IDENTITY CASCADE`);

    const counts: string[] = [];
    for (const t of order) {
      const names = cols.get(t)!;
      if (!names.length) continue;
      const later = deferred.get(t) ?? new Set<string>();
      const list = names.map(ident).join(', ');
      const { rows } = await src.query<Record<string, string | null>>(`SELECT ${list} FROM ${ident(t)}`);
      // Batches that stay well under Postgres's parameter limit and a sensible message size.
      let i = 0;
      while (i < rows.length) {
        const batch: Record<string, string | null>[] = [];
        let bytes = 0;
        while (i < rows.length && batch.length * names.length < 30_000 && bytes < 4_000_000) {
          const r = rows[i++];
          batch.push(r);
          for (const n of names) bytes += r[n]?.length ?? 0;
        }
        const params: (string | null)[] = [];
        const tuples = batch.map((r) => '(' + names.map((n) => {
          params.push(later.has(n) ? null : r[n]);
          return '$' + params.length;
        }).join(', ') + ')');
        await dst.query(`INSERT INTO ${ident(t)} (${list}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`, params);
      }
      counts.push(`${t} ${rows.length}`);
    }

    // Fill in the links left empty on the first pass.
    for (const [t, later] of deferred) {
      const keyCols = await primaryKey(dst, t);
      if (!keyCols.length) throw new Error(`${t} has no primary key to fill in ${[...later].join(', ')}`);
      const want = [...keyCols, ...later];
      const { rows } = await src.query<Record<string, string | null>>(
        `SELECT ${want.map(ident).join(', ')} FROM ${ident(t)} WHERE ${[...later].map((c) => `${ident(c)} IS NOT NULL`).join(' OR ')}`);
      const sets = [...later].map((c, k) => `${ident(c)} = $${k + 1}`).join(', ');
      const where = keyCols.map((c, k) => `${ident(c)} = $${later.size + k + 1}`).join(' AND ');
      for (const r of rows) {
        await dst.query(`UPDATE ${ident(t)} SET ${sets} WHERE ${where}`, [...[...later].map((c) => r[c]), ...keyCols.map((c) => r[c])]);
      }
    }

    // Counters (ids) carry on from where the old database left off.
    const { rows: seqs } = await src.query<{ s: string; v: string | null }>(
      `SELECT c.relname AS s, (pg_sequence_last_value(c.oid))::text AS v
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'S' AND n.nspname = 'public'`);
    for (const s of seqs) {
      if (s.v === null) continue; // never used
      const ok = await dst.query('SELECT to_regclass($1) AS r', ['public.' + ident(s.s)]);
      if (ok.rows[0].r) await dst.query('SELECT setval($1::regclass, $2::bigint, true)', ['public.' + ident(s.s), s.v]);
    }

    for (const t of tables) await dst.query(`ALTER TABLE ${ident(t)} ENABLE TRIGGER USER`);

    // Check: same number of rows on both sides.
    const wrong: string[] = [];
    for (const t of order) {
      const a = await src.query<{ n: string }>(`SELECT count(*) AS n FROM ${ident(t)}`);
      const b = await dst.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${ident(t)}`);
      if (String(a.rows[0].n) !== String(b.rows[0].n)) wrong.push(`${t} (old ${a.rows[0].n}, new ${b.rows[0].n})`);
    }
    if (wrong.length) throw new Error(`row counts don't match: ${wrong.join(', ')}`);

    await dst.query('COMMIT');
    log(`database copy finished in ${Math.round((Date.now() - started) / 1000)}s: ${counts.join(', ')}`);
    log('database copy: all row counts match. Remove MIGRATE_FROM_URL from the environment now.');
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    dst.release();
    await src.query('ROLLBACK').catch(() => {});
    await src.end().catch(() => {});
  }
}

async function primaryKey(q: Q, table: string): Promise<string[]> {
  const { rows } = await q.query<{ name: string }>(
    `SELECT a.attname AS name FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = to_regclass($1) AND i.indisprimary`, ['public.' + ident(table)]);
  return rows.map((r) => r.name);
}
