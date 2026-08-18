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

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ahead = (ms) => new Date(Date.now() + ms).toISOString();

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-crawlstats-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * insertFeed always writes a fresh, pending feed, so the states the status page
 * exists to show have to be set directly.
 *
 * @param {object} feed
 */
async function seed(feed) {
  const { id, slug } = await q.insertFeed(db, {
    slug: feed.slug,
    feed_url: `https://${feed.slug}.example/feed.xml`,
    site_url: `https://${feed.slug}.example/`,
    title: feed.title ?? feed.slug,
  });

  await db.execute({
    sql: `update feeds set status = ?, last_fetched_at = ?, last_success_at = ?,
                 next_fetch_at = ?, error_count = ?, last_error = ?
          where id = ?`,
    args: [
      feed.status,
      feed.lastFetchedAt ?? null,
      feed.lastSuccessAt ?? null,
      feed.nextFetchAt ?? nowIso(),
      feed.errorCount ?? 0,
      feed.lastError ?? null,
      id,
    ],
  });

  return { id, slug };
}

test('crawlStats counts states, backlog and throughput', async () => {
  const healthy = await seed({
    slug: 'healthy',
    status: 'active',
    lastFetchedAt: ago(120_000),
    lastSuccessAt: ago(120_000),
    nextFetchAt: ahead(3_600_000),
  });

  // Active, but the crawler has not read it successfully in over a day: this
  // is the case the page calls "stale", and it is invisible in a status count.
  await seed({
    slug: 'stale',
    status: 'active',
    lastFetchedAt: ago(90_000_000),
    lastSuccessAt: ago(90_000_000),
    nextFetchAt: ago(60_000),
  });

  await seed({
    slug: 'broken',
    status: 'error',
    lastFetchedAt: ago(600_000),
    lastSuccessAt: ago(200_000_000),
    nextFetchAt: ago(60_000),
    errorCount: 7,
    lastError: 'HTTP 500',
  });

  await seed({ slug: 'gone', status: 'dead', errorCount: 12, nextFetchAt: ago(60_000) });
  await seed({ slug: 'fresh', status: 'pending', nextFetchAt: ahead(600_000) });

  await q.upsertItems(db, healthy.id, [{ guid: 'new-1', title: 'Just in' }]);

  // Throughput no longer comes from counting distinct feeds by their
  // last_fetched_at -- that needed a scan of the whole table, which is what
  // made this page take fifteen seconds. It comes from the crawl_hourly rollup
  // the poller already writes once a tick, so the tick has to be recorded here
  // for the same reason it is recorded in production.
  await q.recordCrawlHour(db, { fetched: 2, succeeded: 1, failed: 1, items: 1 });

  const stats = await q.crawlStats(db);

  assert.equal(stats.total, 5);
  assert.equal(stats.active, 2);
  assert.equal(stats.pending, 1);
  assert.equal(stats.errored, 1);
  assert.equal(stats.dead, 1);

  // 'gone' is dead, so it is not a backlog however overdue it looks.
  assert.equal(stats.due, 2, 'stale + broken are due; the dead feed is not');

  // A rate, not a bucket count: one recorded tick of 2 fetches, over a window
  // that is at least an hour wide, is 2 an hour.
  assert.equal(stats.fetchedLastHour, 2, 'the recorded tick sets the hourly rate');
  assert.equal(stats.succeededLastDay, 1, 'only one crawl in the rollup succeeded');
  assert.equal(stats.staleActive, 1, 'the stale active feed is singled out');
  assert.equal(stats.itemsLastDay, 1);
  assert.ok(stats.lastSuccessAt, 'reports the most recent success across the directory');
  assert.ok(stats.nextFetchAt, 'reports when the next feed comes due');

  // The liveness clock the health badge reads, and the reason it is not
  // derived from the throughput figures: 'healthy' was crawled two minutes ago,
  // so the crawler is plainly running whatever the rollup says.
  assert.equal(stats.idleMinutes, 2, 'minutes since the last successful crawl anywhere');
});

test('the health clock survives a rollup the poller never managed to write', async () => {
  // recordCrawlHour is called inside a try/catch in the poller and is allowed
  // to fail without failing the crawl. When it does, every throughput figure
  // reads zero -- and the page must still be able to tell that the crawler is
  // alive, or it reports an outage every time a bookkeeping write is lost.
  await db.execute('delete from crawl_hourly');

  const stats = await q.crawlStats(db);

  assert.equal(stats.fetchedLastHour, 0, 'no rollup, no throughput figure');
  assert.equal(stats.itemsLastDay, 0);
  assert.equal(stats.idleMinutes, 2, 'but liveness comes off feeds and is unaffected');
  assert.equal(stats.active, 2, 'as do the state counts');
});

test('failingFeeds surfaces the worst offenders with their error', async () => {
  const failing = await q.failingFeeds(db);
  const slugs = failing.map((row) => String(row.slug));

  assert.deepEqual(slugs, ['gone', 'broken'], 'most failures first, dead feeds included');
  assert.equal(String(failing[1].last_error), 'HTTP 500');
});

test('recentlyCrawled is ordered by when the crawler last touched a feed', async () => {
  const recent = await q.recentlyCrawled(db);
  const slugs = recent.map((row) => String(row.slug));

  assert.equal(slugs[0], 'healthy', 'the most recent fetch leads');
  assert.ok(!slugs.includes('fresh'), 'a feed never crawled has nothing to report');
});

test('categoryStats counts every category, including the empty ones', async () => {
  const { total, days, categories } = await q.categoryStats(db);

  assert.equal(days.length, 30, 'a month of daily labels');
  assert.deepEqual(
    categories.map((c) => c.category),
    q.KINDS,
    'every category has a row whether or not the directory holds one',
  );

  const blog = categories.find((c) => c.category === 'blog');
  const reel = categories.find((c) => c.category === 'reel');

  // Four feeds were seeded; 'gone' is dead and counts nowhere.
  assert.equal(total, 4);
  assert.equal(blog.feeds, 4, 'new feeds default to blog');
  assert.equal(blog.share, 1);
  assert.equal(blog.errored, 1);
  assert.equal(blog.addedLastDay, 4, 'all four were inserted just now');
  assert.equal(reel.feeds, 0, 'an empty category still reports itself');
  assert.equal(reel.share, 0);
});

test('categoryStats growth is cumulative, dense, and lands on today’s total', async () => {
  const { categories } = await q.categoryStats(db, 7);
  const blog = categories.find((c) => c.category === 'blog');

  assert.equal(blog.growth.length, 7, 'one point per day, gaps included');
  assert.equal(blog.growth.at(-1), blog.feeds, 'the curve ends where the count is');
  assert.equal(blog.growth[0], 0, 'nothing existed before the feeds were inserted');
  assert.deepEqual(
    [...blog.growth].sort((a, b) => a - b),
    blog.growth,
    'a cumulative count never goes down',
  );
});

test('the hourly rollup accumulates ticks and reports a dense series', async () => {
  const hourAgo = ago(3_600_000);

  await q.recordCrawlHour(db, { fetched: 10, succeeded: 9, failed: 1, items: 40 }, hourAgo);
  await q.recordCrawlHour(db, { fetched: 5, succeeded: 5, failed: 0, items: 12 }, hourAgo);

  const series = await q.indexingHistory(db, 3);
  assert.equal(series.length, 3, 'every hour in the window, whether or not it has a row');

  const bucket = series.find((h) => h.hour === hourAgo.slice(0, 13));
  assert.ok(bucket, 'the hour that was recorded is in the window');
  assert.equal(bucket.fetched, 15, 'two ticks in one hour add up');
  assert.equal(bucket.succeeded, 14);
  assert.equal(bucket.failed, 1);
  assert.equal(bucket.items, 52);
  assert.equal(bucket.recorded, true);

  const untouched = series.filter((h) => h.hour !== hourAgo.slice(0, 13));
  for (const hour of untouched) {
    assert.equal(hour.fetched, 0);
    assert.equal(
      hour.recorded,
      false,
      'an hour nobody wrote down is not an hour the crawler did nothing',
    );
  }
});

test('pruneCrawlHours drops what the charts cannot show', async () => {
  await q.recordCrawlHour(db, { fetched: 1, succeeded: 1, items: 1 }, ago(120 * 86_400_000));

  const removed = await q.pruneCrawlHours(db, 90);
  assert.equal(removed, 1, 'the four-month-old bucket goes');

  const kept = await q.indexingHistory(db, 3);
  assert.ok(
    kept.some((h) => h.fetched > 0),
    'recent buckets survive',
  );
});
