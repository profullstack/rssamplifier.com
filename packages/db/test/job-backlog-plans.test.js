import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, newId, nowIso } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as q from '../src/queries.js';

/**
 * The index choices behind `jobBacklogs`, pinned.
 *
 * These are `indexed by` in the query because this database has **never been
 * ANALYZEd** — there is no `sqlite_stat1` — so SQLite falls back to its built-in
 * guess that an equality beats a range, and picks the status index for two
 * queries that want a date. Measured against production: 17.7s vs 654ms, and
 * 16.1s vs 119ms, for identical results.
 *
 * A plan regression is invisible from the outside — same rows, same numbers,
 * thirty times the wall clock — so the plan itself is the thing worth asserting.
 * Locally the tables are tiny and both plans are instant; only the shape can be
 * checked here, which is precisely why it needs a test rather than a benchmark.
 */

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-plans-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * @param {string} sql
 * @param {unknown[]} args
 * @returns {Promise<string>}
 */
async function plan(sql, args = []) {
  const { rows } = await db.execute({ sql: `explain query plan ${sql}`, args });
  return rows.map((r) => String(r.detail)).join(' | ');
}

test('the submissions count is read off the created_at index, not the status one', async () => {
  const detail = await plan(
    `select count(*) as n from feeds indexed by feeds_created_idx
      where created_at >= ? and status = 'pending'`,
    [nowIso(-3_600_000)],
  );

  assert.match(detail, /feeds_created_idx/);
  assert.doesNotMatch(detail, /feeds_status_success_idx/);
});

test('the enrichment count is read off its own partial index', async () => {
  const detail = await plan(
    `select count(*) as n,
            sum(case when authors_checked_at >= ? then 1 else 0 end) as hour
       from feeds indexed by feeds_authors_due_idx
      where status = 'active' and authors_checked_at is not null`,
    [nowIso(-3_600_000)],
  );

  assert.match(detail, /feeds_authors_due_idx/);
  assert.doesNotMatch(detail, /feeds_status_success_idx/);
});

test('both forced indexes exist, so the hint cannot become an error', async () => {
  // `indexed by` is not a hint SQLite may ignore -- naming an index that does
  // not exist is a hard failure at prepare time. A migration that renamed or
  // dropped either of these would take the whole jobs board down, so the
  // coupling is asserted rather than left to be discovered in production.
  const { rows } = await db.execute(
    `select name from sqlite_master where type = 'index'
       and name in ('feeds_created_idx', 'feeds_authors_due_idx')`,
  );

  assert.equal(rows.length, 2, 'both indexes must exist for jobBacklogs to prepare');
});

test('jobBacklogs still answers with the forced indexes in place', async () => {
  // The plans above say which index; this says the numbers survived the change.
  const now = nowIso();
  await db.execute({
    sql: `insert into feeds (id, slug, title, feed_url, status, next_fetch_at, created_at, updated_at)
          values (?, 'a', 'A', 'https://a.example/feed', 'pending', ?, ?, ?)`,
    args: [newId(), now, now, now],
  });

  const backlogs = await q.jobBacklogs(db);

  assert.equal(typeof backlogs.submittedLastHour, 'number');
  assert.equal(backlogs.submittedLastHour, 1);
  assert.equal(typeof backlogs.pendingFirstCrawl, 'number');
  assert.equal(typeof backlogs.authorsDone, 'number');
  assert.equal(typeof backlogs.authorsLastHour, 'number');
});
