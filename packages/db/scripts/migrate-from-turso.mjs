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
 *   --truncate       empty each table first, then load it whole
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
const ONLY = opt('--tables', '')?.split(',').filter(Boolean) ?? [];

const src = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
// Same TLS handling as src/pg.js: `sslmode=` in the URL would make pg verify
// the box's self-signed certificate, so it is read and removed.
const dstUrl = new URL(process.env.DATABASE_URL);
const wantTls = dstUrl.searchParams.has('sslmode') && dstUrl.searchParams.get('sslmode') !== 'disable';
dstUrl.searchParams.delete('sslmode');
const dst = new pg.Pool({ connectionString: dstUrl.toString(), max: 3, ssl: wantTls ? { rejectUnauthorized: false } : undefined });

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
      await client.query(`truncate "${table}" cascade`);
    } else if (flag('--since-rowid') && hasRowid) {
      after = Number((await client.query(`select coalesce(max(rowid), -1) from "${table}"`)).rows[0].coalesce);
    } else if (existing > 0) {
      log(`${table}: ${existing} rows already there, skipped (use --truncate or --since-rowid)`);
      return;
    }

    const select = `select rowid as __rowid, * from "${table}" where rowid > ? order by rowid limit ?`;
    let cursor = after;
    let total = 0;
    const started = Date.now();
    for (;;) {
      const { rows } = await src.execute({ sql: select, args: [cursor, BATCH] });
      if (!rows.length) break;
      const mapped = rows.map((r) => {
        const o = { ...r };
        if (hasRowid) o.rowid = r.__rowid;
        return o;
      });
      await copyBatch(client, table, cols, types, mapped);
      cursor = Number(rows[rows.length - 1].__rowid);
      total += rows.length;
      if (total % (BATCH * 20) === 0) log(`${table}: ${total} rows (rowid ${cursor}, ${Math.round(total / ((Date.now() - started) / 1000))}/s)`);
      if (rows.length < BATCH) break;
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
