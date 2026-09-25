import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { newId, nowIso } from '../src/client.js';
import { connectTest } from '../src/testdb.js';
import * as q from '../src/queries.js';

/**
 * The index choices behind `jobBacklogs`, pinned.
 *
 * Under SQLite these two queries carried `indexed by`, because that database
 * had never been ANALYZEd — there was no `sqlite_stat1` — so its planner fell
 * back to the built-in guess that an equality beats a range, and picked the
 * status index for two queries that want a date. Measured against production:
 * 17.7s vs 654ms, and 16.1s vs 119ms, for identical results.
 *
 * Postgres has no index hints, and the port dropped the `indexed by` on the
 * strength of one claim: that a planner *with statistics* makes the right
 * choice on its own. That claim is what this file asserts. A plan regression is
 * invisible from the outside — same rows, same numbers, thirty times the wall
 * clock — so the plan itself is the thing worth pinning.
 *
 * Locally the table is tiny, and on a tiny table the planner is right to read
 * the heap. So the test builds the *shape* of production — most feeds pending
 * and old, a handful submitted this hour; most active feeds unstamped, a few
 * stamped — runs ANALYZE, and asks the planner which index it would use when a
 * sequential scan is off the table. That is the decision production makes; only
 * the row counts differ.
 */

let db;

before(async () => {
  db = await connectTest();

  const now = nowIso();
  const longAgo = nowIso(-30 * 24 * 3_600_000);
  const rows = [];
  for (let i = 0; i < 400; i += 1) {
    // 380 pending feeds from a bulk upload a month ago, 20 submitted just now.
    const fresh = i < 20;
    rows.push({
      sql: `insert into feeds (id, slug, title, feed_url, status, next_fetch_at, created_at, updated_at)
            values (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      args: [newId(), `p${i}`, `P ${i}`, `https://p${i}.example/feed`, now, fresh ? now : longAgo, now],
    });
  }
  for (let i = 0; i < 400; i += 1) {
    // 400 active feeds, of which 10 have been through the author pass.
    const stamped = i < 10;
    rows.push({
      sql: `insert into feeds (id, slug, title, feed_url, status, next_fetch_at, created_at, updated_at, authors_checked_at)
            values (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      args: [newId(), `a${i}`, `A ${i}`, `https://a${i}.example/feed`, now, longAgo, now, stamped ? now : null],
    });
  }
  await db.batch(rows, 'write');
  await db.execute('analyze feeds');
});

after(async () => {
  db.close();
});

/**
 * The plan Postgres would choose for `sql` if it could not fall back to reading
 * the whole table — `set local` scopes the switch to this one transaction, so
 * nothing leaks to the pooled connection.
 *
 * @param {string} sql
 * @param {unknown[]} args
 * @returns {Promise<string>}
 */
async function plan(sql, args = []) {
  const [, explained] = await db.batch(
    ['set local enable_seqscan = off', { sql: `explain ${sql}`, args }],
    'write',
  );
  return explained.rows.map((r) => String(r['QUERY PLAN'])).join(' | ');
}

test('the submissions count is read off the created_at index, not the status one', async () => {
  const detail = await plan(
    `select count(*) as n from feeds
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
       from feeds
      where status = 'active' and authors_checked_at is not null`,
    [nowIso(-3_600_000)],
  );

  assert.match(detail, /feeds_authors_due_idx/);
  assert.doesNotMatch(detail, /feeds_status_success_idx/);
});

test('both indexes exist, so the plans above have something to choose', async () => {
  // There is no `indexed by` to fail at prepare time any more, which is exactly
  // the danger: a migration that renamed or dropped either index would not be
  // an error anywhere, just a jobs board that takes thirty times longer to
  // draw. The coupling is asserted rather than left to be discovered in
  // production.
  const { rows } = await db.execute(
    `select indexname from pg_indexes where tablename = 'feeds'
       and indexname in ('feeds_created_idx', 'feeds_authors_due_idx')`,
  );

  assert.equal(rows.length, 2, 'both indexes must exist for jobBacklogs to stay fast');
});

test('jobBacklogs still answers with the indexes in place', async () => {
  // The plans above say which index; this says the numbers survived the change.
  const backlogs = await q.jobBacklogs(db);

  assert.equal(typeof backlogs.submittedLastHour, 'number');
  assert.equal(backlogs.submittedLastHour, 20);
  assert.equal(typeof backlogs.pendingFirstCrawl, 'number');
  assert.equal(backlogs.pendingFirstCrawl, 400);
  assert.equal(typeof backlogs.authorsDone, 'number');
  assert.equal(backlogs.authorsDone, 10);
  assert.equal(typeof backlogs.authorsLastHour, 'number');
  assert.equal(backlogs.authorsLastHour, 10);
});
