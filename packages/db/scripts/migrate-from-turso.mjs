#!/usr/bin/env node
/**
 * Copy the Turso (SQLite) database into Postgres.
 *
 *   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... \
 *   DATABASE_URL=postgres://... \
 *   node packages/db/scripts/migrate-from-turso.mjs [--tables a,b] [--since-rowid] [--truncate] [--batch 5000]
 *
 * The Postgres schema must already be applied (`migrate()` does that on boot,
 * or run `node packages/db/src/migrate.js`). Every ordinary table is copied
 * with COPY ... FROM STDIN, 5,000 rows a batch, paged out of SQLite by rowid,
 * which is SQLite's own physical order and also what the three `rowid`
 * columns on the Postgres side are filled from: the identity columns take the
 * SQLite rowid verbatim, so the dataset export cursors that page on rowid keep
 * their positions across the move.
 *
 * SQLite is dynamically typed, so a text column can hold a number and an
 * integer column an empty string; values are coerced to the Postgres column
 * type from information_schema before they are written.
 *
 * Modes:
 *   default          truncate nothing; skip a table that already has rows
 *   --truncate       empty each table first (TRUNCATE ONLY: a table that
 *                    other tables reference is refused, use --upsert)
 *   --upsert         refresh in place by primary key: the way to bring a
 *                    parent table (feeds, users, authors) up to date at cutover
 *   --since-rowid    append only rows whose SQLite rowid is above the largest
 *                    rowid already in Postgres (feed_items, item_extracts,
 *                    feeds carry a rowid column; for other tables this is the
 *                    same as default)
 *   --tables a,b     only these tables
 *
 * Foreign keys are not checked while loading (session_replication_role =
 * replica, which needs a superuser or the table owner with that privilege):
 * SQLite reads are not one snapshot across tables, so a child row can arrive
 * before its parent; run `--verify` afterwards to count rows and find orphans.
 */
import { createClient } from '@libsql/client';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const { from: copyFrom } = copyStreams;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const BATCH = Number(opt('--batch', 5000));
const WORKERS = Number(opt('--workers', 4));
const RANGE = opt('--range', '') ? opt('--range', '').split(':').map(Number) : null;
const ONLY = opt('--tables', '')?.split(',').filter(Boolean) ?? [];

const src = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  // A request that hangs would hang a worker for good; two minutes is far
  // above any batch read that is actually progressing.
  fetch: (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(120_000)].filter(Boolean)) }),
});

/** A Turso read with retries: the platform drops the odd request under load. */
async function read(statement, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await src.execute(statement);
    } catch (err) {
      if (i >= attempts) throw err;
      log(`read failed (${String(err?.message ?? err).slice(0, 80)}); retry ${i}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, 2_000 * i));
    }
  }
}
// Same TLS handling as src/pg.js: `sslmode=` in the URL would make pg verify
// the box's self-signed certificate, so it is read and removed.
const dstUrl = new URL(process.env.DATABASE_URL);
const wantTls = dstUrl.searchParams.has('sslmode') && dstUrl.searchParams.get('sslmode') !== 'disable';
dstUrl.searchParams.delete('sslmode');
const dst = new pg.Pool({ connectionString: dstUrl.toString(), max: WORKERS + 2, ssl: wantTls ? { rejectUnauthorized: false } : undefined });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Tables in dependency order (parents first) so a plain load also satisfies FKs. */
const ORDER = [
  '_migrations', 'users', 'login_tokens', 'sessions', 'credentials', 'webauthn_challenges', 'api_keys',
  'submissions', 'import_entries', 'discovery_runs', 'feeds', 'feed_items', 'item_extracts',
  'item_translations', 'translation_usage', 'feed_keywords', 'topics', 'feed_links', 'feed_removals',
  'discovery_keywords', 'discovery_candidates', 'authors', 'author_links', 'author_profiles',
  'author_searches', 'feed_authors', 'author_follows', 'follows', 'topic_follows', 'post_reactions',
  'comments', 'queue_entries', 'alert_channels', 'alert_sent', 'alert_state', 'dataset_grants',
  'dataset_downloads', 'dataset_enquiries', 'crawl_hourly', 'crawl_log', 'queue_hourly',
  'traffic_hourly', 'x_provider_state', 'x_sessions', 'crawl_sales', 'leaderboard_badges',
  'partner_accounts', 'partner_credits', 'partner_properties', 'rings', 'ring_members', 'ring_likes',
  'ring_events',
];
/** Tables whose SQLite rowid is stored in a Postgres column of the same name. */
const ROWID_TABLES = new Set(['feeds', 'feed_items', 'item_extracts']);
/** _migrations records SQLite file names; Postgres has its own ledger. */
const SKIP = new Set(['_migrations']);

async function pgColumns(table) {
  const { rows } = await dst.query(
    `select column_name, data_type, is_generated, is_identity
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [table],
  );
  return rows.filter((r) => r.is_generated !== 'ALWAYS');
}

async function sqliteColumns(table) {
  const { rows } = await src.execute(`pragma table_info("${table}")`);
  return rows.map((r) => String(r.name));
}

/** COPY text format: tabs, newlines and backslashes escaped, NULL as \N. */
function field(value, type) {
  if (value === null || value === undefined) return '\\N';
  if (typeof value === 'bigint') value = Number(value);
  if (type === 'bigint' || type === 'integer') {
    if (value === '' || value === false) return '\\N';
    if (value === true) return '1';
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.trunc(n)) : '\\N';
  }
  if (type === 'double precision' || type === 'numeric' || type === 'real') {
    if (value === '') return '\\N';
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : '\\N';
  }
  if (value instanceof Uint8Array) value = Buffer.from(value).toString('utf8');
  const s = typeof value === 'string' ? value : String(value);
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

async function copyBatch(client, table, cols, types, rows) {
  const stream = client.query(copyFrom(`copy "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) from stdin`));
  const lines = rows.map((r) => cols.map((c, i) => field(r[c], types[i])).join('\t') + '\n');
  await pipeline(Readable.from(lines), stream);
}

async function loadTable(table) {
  const pgCols = await pgColumns(table);
  if (!pgCols.length) { log(`${table}: not in Postgres, skipped`); return; }
  const srcCols = new Set(await sqliteColumns(table));
  const hasRowid = ROWID_TABLES.has(table);
  // Columns present on both sides; the Postgres rowid column is filled from
  // SQLite's implicit rowid for the three tables that have one.
  const cols = pgCols.map((c) => c.column_name).filter((c) => srcCols.has(c) || (c === 'rowid' && hasRowid));
  const types = cols.map((c) => pgCols.find((p) => p.column_name === c).data_type);

  const client = await dst.connect();
  try {
    await client.query("set session_replication_role = 'replica'");
    const existing = Number((await client.query(`select count(*) from "${table}"`)).rows[0].count);
    let after = -1;
    if (flag('--truncate')) {
      // `only`, never `cascade`: a cascade on a parent table (feeds, users)
      // silently empties every table referencing it. A parent is refreshed
      // with --upsert instead; this errors out on one rather than wiping.
      await client.query(`truncate only "${table}"`);
    } else if (flag('--upsert')) {
      await upsertTable(client, table, cols, types, srcCols);
      return;
    } else if ((flag('--since-rowid') || RANGE) && hasRowid) {
      after = Number((await client.query(`select coalesce(max(rowid), -1) from "${table}"`)).rows[0].coalesce);
    } else if (existing > 0) {
      log(`${table}: ${existing} rows already there, skipped (use --truncate or --since-rowid)`);
      return;
    }

    // Wide tables (feed_items carries content_html) read out of Turso at well
    // under a thousand rows a second on one connection, and Turso serves
    // concurrent reads happily: the rowid range is split into WORKERS slices,
    // each with its own Postgres connection, and copied in parallel. Rows still
    // land in rowid order within a slice, which is all the cursors need.
    // Two lookups, not `min(rowid), max(rowid)` in one: SQLite answers a lone
    // min or max from the rowid index but scans the whole table for the pair,
    // which on 15M rows over the network is a stall.
    // --range lo:hi copies only SQLite rowids in (lo, hi]: the way to re-split
    // a slice that was left running alone after the others finished.
    if (RANGE) after = RANGE[0];
    const first = (await read({ sql: `select rowid as r from "${table}" where rowid > ? order by rowid limit 1`, args: [after] })).rows[0];
    const last = RANGE
      ? { r: RANGE[1] }
      : (await read({ sql: `select rowid as r from "${table}" order by rowid desc limit 1` })).rows[0];
    const lo = first ? Number(first.r) : null;
    const hi = lo === null ? null : Number(last.r);
    const started = Date.now();
    let total = 0;
    if (lo !== null) {
      const span = hi - lo + 1;
      const workers = Math.max(1, Math.min(WORKERS, Math.ceil(span / BATCH)));
      const slice = Math.ceil(span / workers);
      const select = `select rowid as __rowid, * from "${table}" where rowid > ? and rowid <= ? order by rowid limit ?`;
      const runSlice = async (from, to) => {
        const conn = await dst.connect();
        try {
          await conn.query("set session_replication_role = 'replica'");
          let cursor = from - 1;
          for (;;) {
            const { rows } = await read({ sql: select, args: [cursor, to, BATCH] });
            if (!rows.length) break;
            const mapped = rows.map((r) => {
              const o = { ...r };
              if (hasRowid) o.rowid = r.__rowid;
              return o;
            });
            await copyBatch(conn, table, cols, types, mapped);
            cursor = Number(rows[rows.length - 1].__rowid);
            total += rows.length;
            if (total % (BATCH * 20) < rows.length) log(`${table}: ${total} rows (${Math.round(total / ((Date.now() - started) / 1000))}/s)`);
            if (rows.length < BATCH) break;
          }
        } finally {
          conn.release();
        }
      };
      const jobs = [];
      for (let i = 0; i < workers; i++) jobs.push(runSlice(lo + i * slice, Math.min(hi, lo + (i + 1) * slice - 1)));
      await Promise.all(jobs);
    }
    // Identity columns took explicit values; move their sequences past them.
    for (const c of pgCols.filter((p) => p.is_identity === 'YES')) {
      await client.query(
        `select setval(pg_get_serial_sequence($1, $2), greatest(coalesce((select max("${c.column_name}") from "${table}"), 0), 1))`,
        [`public.${table}`, c.column_name],
      );
    }
    log(`${table}: done, ${total} rows in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    client.release();
  }
}

/**
 * Refresh a table in place: COPY the whole SQLite table into a temp table,
 * then insert-or-update by primary key. Rows deleted in SQLite stay behind
 * (nothing here deletes), and children are never touched.
 */
async function upsertTable(client, table, cols, types, srcCols) {
  const { rows: pk } = await client.query(
    `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = $1::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`,
    [`public."${table}"`],
  );
  if (!pk.length) throw new Error(`${table}: no primary key, cannot upsert`);
  const pkCols = pk.map((r) => r.attname);
  const hasRowid = ROWID_TABLES.has(table);
  const tmp = `tmp_${table}`;
  const started = Date.now();
  await client.query(`create temp table "${tmp}" (like "${table}" including defaults excluding identity excluding generated excluding indexes excluding constraints) on commit drop`);
  await client.query('begin');
  try {
    await client.query("set local session_replication_role = 'replica'");
    let total = 0;
    let cursor = -1;
    const select = `select rowid as __rowid, * from "${table}" where rowid > ? order by rowid limit ?`;
    for (;;) {
      const { rows } = await read({ sql: select, args: [cursor, BATCH] });
      if (!rows.length) break;
      const mapped = rows.map((r) => { const o = { ...r }; if (hasRowid) o.rowid = r.__rowid; return o; });
      await copyBatch(client, tmp, cols, types, mapped);
      cursor = Number(rows[rows.length - 1].__rowid);
      total += rows.length;
      if (rows.length < BATCH) break;
    }
    const q = (c) => `"${c}"`;
    const nonPk = cols.filter((c) => !pkCols.includes(c));
    const set = nonPk.length ? `do update set ${nonPk.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}` : 'do nothing';
    const res = await client.query(
      `insert into "${table}" (${cols.map(q).join(', ')}) overriding system value
         select ${cols.map(q).join(', ')} from "${tmp}"
         on conflict (${pkCols.map(q).join(', ')}) ${set}`,
    );
    await client.query('commit');
    log(`${table}: upserted ${res.rowCount} of ${total} rows in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  }
}

async function verify() {
  let bad = 0;
  for (const table of ORDER) {
    if (SKIP.has(table)) continue;
    const s = Number((await src.execute(`select count(*) as n from "${table}"`)).rows[0].n);
    const d = Number((await dst.query(`select count(*) from "${table}"`)).rows[0].count);
    const ok = s === d ? 'ok' : 'DIFF';
    if (ok !== 'ok') bad++;
    console.log(`${table.padEnd(24)} ${String(s).padStart(10)} ${String(d).padStart(10)} ${ok}`);
  }
  const { rows } = await dst.query(`
    select 'feed_items' as t, count(*) from feed_items i where not exists (select 1 from feeds f where f.id = i.feed_id)
    union all select 'item_extracts', count(*) from item_extracts e where not exists (select 1 from feed_items i where i.id = e.item_id)
    union all select 'feed_keywords', count(*) from feed_keywords k where not exists (select 1 from feeds f where f.id = k.feed_id)`);
  for (const r of rows) console.log(`orphans in ${r.t}: ${r.count}`);
  return bad;
}

const main = async () => {
  if (flag('--verify')) {
    const bad = await verify();
    process.exit(bad ? 1 : 0);
  }
  const tables = ORDER.filter((t) => !SKIP.has(t) && (!ONLY.length || ONLY.includes(t)));
  for (const t of tables) await loadTable(t);
  log('all tables loaded');
};

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => { src.close(); await dst.end(); });
