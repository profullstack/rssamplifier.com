import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, nowIso } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as q from '../src/queries.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-crawllog-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a log flush is one autocommit statement, not a write transaction', async () => {
  const calls = [];
  const client = {
    execute: async (statement) => {
      calls.push(statement);
      return { rowsAffected: 2 };
    },
    batch: async () => {
      throw new Error('the log must not join the throttled transaction queue');
    },
  };

  const written = await q.appendCrawlLog(client, [
    { event: 'crawl-error', status: 'error', detail: 'timeout' },
    { event: 'crawl', detail: '{"crawled":25}' },
  ]);

  assert.equal(written, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /values \(\?, \?, \?, \?, \?, \?, \?, \?\), \(\?, \?, \?, \?, \?, \?, \?, \?\)/);
  assert.equal(calls[0].args.length, 16);
});

test('the rollups and the prune DO take their turn in the queue', async () => {
  // The other half of the rule above, and the reason it is worth a test of its
  // own: only `client.batch` is serialised, so a write issued through
  // `execute` does not queue behind the crawl's writes, it competes with them
  // for the single lock SQLite has. The queue sample failed on every tick in
  // production — always the 30-second deadline, while every read feeding it
  // returned inside 1.4s. It was starving, not slow.
  //
  // The log is exempt because it reports on the queue. Nothing else is.
  const seen = [];
  const client = {
    execute: async () => {
      throw new Error('a bookkeeping write must not race the queue it should be in');
    },
    batch: async (statements, mode) => {
      seen.push({ sql: statements[0].sql, mode });
      return [{ rowsAffected: 1, rows: [] }];
    },
  };

  await q.recordQueueHour(client, { due: 1, firstCrawl: 2, cards: 3, authors: 4 });
  await q.recordCrawlHour(client, { fetched: 1, succeeded: 1, failed: 0, items: 5 });
  await q.pruneCrawlLog(client, 12, 100);

  assert.equal(seen.length, 3, 'all three went through batch');
  assert.ok(seen.every((s) => s.mode === 'write'), "and asked for the write path");
  assert.match(seen[0].sql, /insert into queue_hourly/);
  assert.match(seen[1].sql, /insert into crawl_hourly/);
  assert.match(seen[2].sql, /delete from crawl_log/);
});

test('a line keeps the fields a reader needs and nothing is invented', async () => {
  const written = await q.appendCrawlLog(db, [
    {
      event: 'feed',
      status: 'ok',
      subject: 'Example Blog',
      slug: 'example-blog',
      amount: 3,
      ms: 412,
    },
    { event: 'crawl', detail: JSON.stringify({ crawled: 25, failed: 0 }) },
  ]);

  assert.equal(written, 2);

  const rows = await q.crawlLog(db, { since: 0 });
  assert.equal(rows.length, 2);

  const [feed, batch] = rows;
  assert.equal(String(feed.event), 'feed');
  assert.equal(String(feed.subject), 'Example Blog');
  assert.equal(Number(feed.amount), 3);
  assert.equal(Number(feed.ms), 412);
  assert.ok(String(feed.at).endsWith('Z'), 'the timestamp defaults to now, in ISO');

  // Absent fields stay absent rather than becoming 0 or '': a line that reports
  // "0 posts" when it never counted any is a line that lies.
  assert.equal(batch.status, null);
  assert.equal(batch.amount, null);
  assert.equal(batch.ms, null);
});

test('the cursor is the row id, so lines written in the same millisecond all survive', async () => {
  const at = nowIso();
  await q.appendCrawlLog(db, [
    { event: 'feed', at, subject: 'a' },
    { event: 'feed', at, subject: 'b' },
    { event: 'feed', at, subject: 'c' },
  ]);

  const all = await q.crawlLog(db, { since: 0 });
  const sameMs = all.filter((r) => String(r.at) === at);
  assert.equal(sameMs.length, 3, 'a timestamp cursor would have collapsed these into one');

  // Reading forward from the first of them returns the other two, in order.
  const after = await q.crawlLog(db, { since: Number(sameMs[0].id) });
  assert.deepEqual(
    after.map((r) => String(r.subject)),
    ['b', 'c'],
  );
});

test('ids ascend, so a stream can append what it reads', async () => {
  const rows = await q.crawlLog(db, { since: 0 });
  const ids = rows.map((r) => Number(r.id));

  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

test('the tail is the newest lines, oldest first', async () => {
  const tail = await q.crawlLogTail(db, 2);
  const all = await q.crawlLog(db, { since: 0 });

  assert.equal(tail.length, 2);
  assert.deepEqual(
    tail.map((r) => Number(r.id)),
    all.slice(-2).map((r) => Number(r.id)),
    'the limit takes the end of the log, and the log still reads downwards',
  );
});

test('operational errors survive outside the rolling feed log', async () => {
  await q.appendCrawlLog(db, [
    { event: 'feed', status: 'error', subject: 'broken.example', detail: 'http-500' },
    { event: 'crawl-error', status: 'error', detail: 'database timed out' },
    { event: 'cluster-backfill-error', status: 'error', detail: 'database is locked' },
    { event: 'crawl', detail: '{"crawled":25}' },
  ]);

  const errors = await q.crawlOperationalErrors(db, { limit: 10, hours: 1 });

  assert.deepEqual(
    errors.slice(0, 2).map((row) => String(row.event)),
    ['cluster-backfill-error', 'crawl-error'],
    'newest first, without ordinary per-feed failures',
  );
  assert.ok(errors.every((row) => row.status === 'error'));
});

test('a line with no event is not a line', async () => {
  assert.equal(await q.appendCrawlLog(db, []), 0);
  assert.equal(await q.appendCrawlLog(db, [{ subject: 'nothing to say' }]), 0);
});

test('the prune keeps the window and drops what is behind it', async () => {
  await q.appendCrawlLog(db, [
    { event: 'feed', at: nowIso(-13 * 3_600_000), subject: 'yesterday' },
    { event: 'feed', at: nowIso(-2 * 3_600_000), subject: 'this morning' },
  ]);

  const removed = await q.pruneCrawlLog(db, 12);
  assert.equal(removed, 1);

  const left = await q.crawlLog(db, { since: 0, limit: 1000 });
  assert.ok(!left.some((r) => String(r.subject) === 'yesterday'));
  assert.ok(left.some((r) => String(r.subject) === 'this morning'));
});

test('the prune takes a slice, so a lapsed sweep cannot become one huge delete', async () => {
  // The failure this guards against: the sweep stopped being reached, the table
  // grew to 64 hours of a 12-hour window, and an unbounded catch-up delete is
  // ~120,000 rows in one statement against a 30-second deadline — which times
  // out, and times out again every hour, never shrinking the arrears that made
  // it too big.
  const old = nowIso(-13 * 3_600_000);
  await q.appendCrawlLog(
    db,
    Array.from({ length: 12 }, (_, i) => ({ event: 'feed', at: old, subject: `old-${i}` })),
  );

  const first = await q.pruneCrawlLog(db, 12, 5);
  assert.equal(first, 5, 'one slice, not the whole backlog');

  const second = await q.pruneCrawlLog(db, 12, 5);
  assert.equal(second, 5, 'and the next slice takes the next five');

  const third = await q.pruneCrawlLog(db, 12, 5);
  assert.ok(third < 5, 'a short slice is how the caller knows it has caught up');

  const left = await q.crawlLog(db, { since: 0, limit: 1000 });
  assert.ok(!left.some((r) => String(r.subject).startsWith('old-')), 'all of it went eventually');
});

test('a caller cannot ask for the whole table', async () => {
  // The stream passes a limit through from a query string, so the ceiling is
  // load-bearing rather than decorative.
  const rows = await q.crawlLog(db, { since: 0, limit: 10_000 });
  assert.ok(rows.length <= 1000);
});
