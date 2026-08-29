import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q } from '@rssamplifier/db';

import { crawlDue } from '../src/crawl.js';

/**
 * Believing a 429 once, for the whole host, instead of once per feed.
 *
 * The measured failure, 2026-08-29. A bulk import put 50,099 feeds on
 * `www.reddit.com` — 41% of the entire due queue. Because a host's feeds are
 * crawled strictly in series, and because `spreadHosts` deliberately lifts its
 * per-host cap rather than under-fill a batch, one worker was handed most of a
 * 900-feed batch on a single host and walked it into the same rate limit over
 * and over. Over one hour: 1,074 attempts to reddit of which 1,015 were
 * refused, against 218 crawls for the whole rest of the directory. The crawler
 * had not slowed down — it was spending 84% of itself being told to go away.
 *
 * A 429 is a fact about the host, and the fix is to stop asking. What these
 * tests hold down is that stopping is cheap, that it does not blame the feeds
 * it never sent a request for, and that the ones it holds back come back
 * spread out rather than as the same pile-up one interval later.
 */

let dir;
let db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rsa-host-throttle-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/**
 * Put `n` feeds on one host, all due now.
 *
 * @param {string} host
 * @param {number} n
 * @returns {Promise<string[]>} their ids, in the order they were created
 */
async function seedHost(host, n) {
  const ids = [];
  const past = new Date(Date.now() - 3_600_000).toISOString();

  for (let i = 0; i < n; i += 1) {
    const { id } = await q.insertFeed(db, {
      slug: `${host.split('.')[0]}-${i}`,
      feed_url: `https://${host}/r/sub${i}/new.rss`,
      title: `${host} ${i}`,
    });
    // `insertFeed` stamps last_fetched_at/last_success_at at insert; a feed from
    // a bulk import has never been read, and that is the fixture these need.
    await db.execute({
      sql: `update feeds
              set next_fetch_at = ?, status = ?, last_fetched_at = null, last_success_at = null
            where id = ?`,
      args: [past, 'pending', id],
    });
    ids.push(id);
  }

  return ids;
}

/** A resolver that refuses everything the way a rate-limited host does. */
const alwaysThrottled = async () => ({
  ok: false,
  error: 'http-429',
  throttled: true,
  retryAfter: 120,
});

test('one 429 ends the whole host queue instead of being hit once per feed', async () => {
  await seedHost('crowded.example', 25);

  let attempts = 0;
  const resolve = async (...args) => {
    attempts += 1;
    return alwaysThrottled(...args);
  };

  const result = await crawlDue(db, 25, 4, null, { crawl: { resolve } });

  // The point of the whole change: 25 feeds on one host cost one request, not
  // twenty-five. Before this, every feed in the queue was asked separately.
  assert.equal(attempts, 1, 'the host is asked once and believed');
  assert.equal(result.throttled, 1, 'and the batch reports that it happened');
});

test('the feeds it never asked about are not blamed for the refusal', async () => {
  // The damage this prevents is the same one `markThrottled` exists for, but a
  // queue wide: ten consecutive failures marks a feed dead, so recording a rate
  // limit against feeds we did not even send a request for would retire a whole
  // platform out of the directory for our own crawl rate.
  const ids = await seedHost('crowded.example', 12);

  await crawlDue(db, 12, 4, null, { crawl: { resolve: alwaysThrottled } });

  const rows = await db.execute({
    sql: `select status, error_count, last_error, last_success_at, last_fetched_at
            from feeds where id in (${ids.slice(1).map(() => '?').join(',')})`,
    args: ids.slice(1),
  });

  assert.equal(rows.rows.length, 11);
  for (const row of rows.rows) {
    assert.equal(row.error_count, 0, 'never asked, so nothing to count against it');
    assert.equal(row.status, 'pending', 'and its status is untouched');
    assert.equal(row.last_error, null);
    assert.equal(row.last_fetched_at, null, 'we did not read this publisher');
  }
});

test('the held-back feeds come back spread out, not all at the same instant', async () => {
  // Rescheduling a held-back queue to one moment just moves the pile-up: they
  // would come due together and walk into the same wall one interval later.
  const ids = await seedHost('crowded.example', 40);

  await crawlDue(db, 40, 4, null, { crawl: { resolve: alwaysThrottled } });

  const rows = await db.execute({
    sql: `select next_fetch_at from feeds where id in (${ids
      .slice(1)
      .map(() => '?')
      .join(',')})`,
    args: ids.slice(1),
  });

  const times = [...new Set(rows.rows.map((r) => String(r.next_fetch_at)))];
  assert.ok(times.length > 1, 'they do not all return at once');

  const stamps = times.map((t) => Date.parse(t)).sort((a, b) => a - b);
  const spanMinutes = (stamps[stamps.length - 1] - stamps[0]) / 60_000;
  assert.ok(spanMinutes > 0, 'the return is spread across a window');

  // Retry-After: 120s is two minutes, and nothing may come back sooner than the
  // server asked for.
  const earliest = (stamps[0] - Date.now()) / 60_000;
  assert.ok(earliest >= 1.5, `first return honours Retry-After, got ${earliest}m`);
});

test('a host that is merely slow is still walked to the end', async () => {
  // The guard must not swallow ordinary failures: a 404 is evidence about one
  // feed and says nothing about the host, so the queue continues.
  await seedHost('broken.example', 6);

  let attempts = 0;
  const resolve = async () => {
    attempts += 1;
    return { ok: false, error: 'http-404' };
  };

  const result = await crawlDue(db, 6, 4, null, { crawl: { resolve } });

  assert.equal(attempts, 6, 'every feed is still tried');
  assert.equal(result.throttled, 0);
});

test('one throttled host does not stop the others in the same batch', async () => {
  // The whole reason the bug mattered: the rest of the directory was starved.
  // A refusal from one host must cost that host's queue and nothing else.
  await seedHost('crowded.example', 20);
  await seedHost('fine.example', 5);

  const resolve = async (url) => {
    if (String(url).includes('crowded.example')) return alwaysThrottled();
    return { ok: false, error: 'http-404' };
  };

  const result = await crawlDue(db, 25, 4, null, { crawl: { resolve } });

  assert.equal(result.throttled, 1, 'the crowded host bowed out');
  assert.equal(result.hosts, 2, 'and the other host was still its own queue');

  const fine = await db.execute(
    "select count(*) as n from feeds where feed_url like '%fine.example%' and error_count > 0",
  );
  assert.equal(Number(fine.rows[0].n), 5, 'every feed on the healthy host was crawled');
});
