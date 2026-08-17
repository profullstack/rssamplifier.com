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

test('a caller cannot ask for the whole table', async () => {
  // The stream passes a limit through from a query string, so the ceiling is
  // load-bearing rather than decorative.
  const rows = await q.crawlLog(db, { since: 0, limit: 10_000 });
  assert.ok(rows.length <= 1000);
});
