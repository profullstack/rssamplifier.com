import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, newId, q } from '@rssamplifier/db';

import { crawlFeed, nextIntervalMinutes } from '../src/crawl.js';

/**
 * What a re-crawl reports, and what the crawler does about it.
 *
 * The bug these cover cost the directory a factor of twenty-four in crawl
 * volume and was invisible from every angle that mattered: `upsertItems`
 * returns how many items the document *offered*, not how many were stored, and
 * `crawlFeed` was reading that as "new items". Since every crawl re-offers the
 * whole feed, the number was never zero — so `nextIntervalMinutes` always
 * returned its floor and every feed in the directory was re-read hourly for
 * ever, however quiet it was. The backoff ladder that is supposed to let a
 * dormant blog drift out to a day had never once engaged in production.
 *
 * Nothing failed. The crawler simply asked for twenty-four times the work it
 * was designed to ask for, and the backlog was read as "the crawler is slow".
 */

let dir;
let db;

/** A feed document that never changes, the way a dormant blog's does not. */
const DOCUMENT = {
  ok: true,
  feed: {
    title: 'A Quiet Blog',
    description: 'It posts rarely.',
    categories: ['writing'],
    credits: [],
    items: Array.from({ length: 5 }, (_, i) => ({
      guid: `post-${i}`,
      url: `https://quiet.example/${i}`,
      title: `Post ${i}`,
      summary: 'Words.',
      publishedAt: '2026-08-01T00:00:00.000Z',
    })),
  },
};

beforeEach(async () => {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'recrawl-'));
  db = connect({ url: `file:${join(dir, `${newId()}.db`)}` });
  await migrate(db);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** @returns {Promise<object>} the feed row, as the crawl loop reads it */
async function seed() {
  await q.insertFeed(db, {
    slug: 'quiet',
    feed_url: 'https://quiet.example/feed.xml',
    title: 'A Quiet Blog',
  });
  return q.feedBySlug(db, 'quiet');
}

const resolve = async () => DOCUMENT;

test('a first crawl reports what it actually stored', async () => {
  const feed = await seed();
  const res = await crawlFeed(db, feed, { resolve });

  assert.equal(res.ok, true);
  assert.equal(res.newItems, 5);
});

test('a re-crawl that stores nothing reports nothing', async () => {
  const feed = await seed();
  await crawlFeed(db, feed, { resolve });

  // The same document again — which is what every crawl of a dormant feed sees.
  const again = await q.feedBySlug(db, 'quiet');
  const res = await crawlFeed(db, again, { resolve });

  assert.equal(res.newItems, 0, 'items offered is not items stored');
});

test('a quiet feed backs off instead of being re-read hourly for ever', async () => {
  const feed = await seed();
  await crawlFeed(db, feed, { resolve });

  const first = await q.feedBySlug(db, 'quiet');
  assert.equal(Number(first.fetch_interval_minutes), 60, 'a feed that just published stays hourly');

  await crawlFeed(db, first, { resolve });
  const second = await q.feedBySlug(db, 'quiet');
  assert.equal(Number(second.fetch_interval_minutes), 120, 'and one that did not, doubles');

  await crawlFeed(db, second, { resolve });
  const third = await q.feedBySlug(db, 'quiet');
  assert.equal(Number(third.fetch_interval_minutes), 240);
});

test('a re-crawl that stored nothing does not go near the author path again', async () => {
  // What limits this crawler is write transactions per feed, not bytes and not
  // fetches: against production an *empty* write transaction measured 29-118
  // seconds while a read measured 100ms, and they serialize per database.
  //
  // `storeCredits` was three of them on every single crawl -- an `update
  // authors` coalescing each column onto the value already in it, an insert
  // into feed_authors and one into author_links -- re-deriving an unchanged
  // byline from an unchanged document. Instrumenting a crawl showed a re-crawl
  // costing 4 write transactions of which 3 changed nothing; guarding it on the
  // same condition the topics block uses takes that to 1.
  // The shared DOCUMENT names nobody, so this test brings its own byline.
  const credited = async () => ({
    ok: true,
    feed: {
      ...DOCUMENT.feed,
      credits: [{ name: 'A Quiet Author', url: 'https://quiet.example/about',
                  confidence: 0.9, source: 'feed', role: 'author' }],
    },
  });

  const feed = await seed();

  // First crawl: the author is genuinely new, so it must be stored.
  await crawlFeed(db, feed, { resolve: credited });
  const after = await db.execute({
    sql: 'select count(*) as n from feed_authors where feed_id = ?',
    args: [String(feed.id)],
  });
  assert.equal(Number(after.rows[0].n), 1, 'a first crawl files the byline it was given');

  // `updated_at` on the author row is the witness: `upsertAuthor` stamps it on
  // every call, so if the author path ran at all this value moves -- even
  // though every other column it writes would land on the value already there.
  // That indistinguishability is the whole reason the waste went unnoticed.
  const stamp = async () =>
    String((await db.execute("select updated_at from authors limit 1")).rows[0].updated_at);
  const was = await stamp();

  // Second crawl of the same document, which stores no new items.
  const res = await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve: credited });

  assert.equal(res.newItems, 0, 'nothing new was stored');
  assert.equal(await stamp(), was, 'and the author was never written again');

  // The feed row itself is of course still updated -- a crawl has to record
  // that it happened. This test is about the three writes that came after it.
  const touched = await q.feedBySlug(db, 'quiet');
  assert.ok(touched.last_fetched_at, 'the crawl still recorded itself');

  // And the byline is still there -- skipped, not dropped.
  const still = await db.execute({
    sql: 'select count(*) as n from feed_authors where feed_id = ?',
    args: [String(feed.id)],
  });
  assert.equal(Number(still.rows[0].n), 1);
});

test('the interval the crawl writes is one SQL statement agreeing with the JS ladder', async () => {
  // `storeCrawl` computes the backoff inside the UPDATE, so that the items and
  // the feed row cost one write transaction between them rather than two. That
  // makes `nextIntervalMinutes` a second, independent statement of the same
  // ladder -- so it is worth asserting they cannot drift apart.
  for (const [newItems, current, expected] of [
    [1, 60, 60],
    [1, 480, 60],
    [0, 60, 120],
    [0, 120, 240],
    [0, 720, 1440],
    [0, 1440, 1440],
  ]) {
    assert.equal(
      nextIntervalMinutes(newItems, current),
      expected,
      `ladder: ${newItems} new at ${current}m`,
    );
  }
});

test('next_fetch_at is written in the format the due query compares against', async () => {
  // This is the one that would fail silently. `next_fetch_at` moved from a JS
  // `toISOString()` into SQL `strftime`, and `dueFeeds` selects on
  // `next_fetch_at <= ?` against an ISO string -- a string comparison. A format
  // that merely *sorts* differently (a space instead of the T, a missing Z, no
  // milliseconds) would leave every feed either permanently due or permanently
  // not, with nothing in the logs to say why.
  const feed = await seed();
  await crawlFeed(db, feed, { resolve });

  const row = await q.feedBySlug(db, 'quiet');
  const written = String(row.next_fetch_at);

  assert.match(
    written,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    `next_fetch_at must be an ISO instant, got ${written}`,
  );
  // Round-trips through Date, and lands an hour out rather than anywhere else.
  const minutes = (Date.parse(written) - Date.now()) / 60_000;
  assert.ok(minutes > 55 && minutes <= 61, `an hour ahead, got ${minutes.toFixed(1)}m`);

  // And the scheduler agrees: not due now, due once the clock passes it.
  const dueNow = await q.dueFeeds(db, 100);
  assert.equal(
    dueNow.some((f) => String(f.slug) === 'quiet'),
    false,
    'a feed just crawled is not immediately due again',
  );
});

test('a feed that publishes again drops straight back to hourly', async () => {
  const feed = await seed();
  await crawlFeed(db, feed, { resolve });
  await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve });
  assert.equal(Number((await q.feedBySlug(db, 'quiet')).fetch_interval_minutes), 120);

  const withNews = {
    ok: true,
    feed: {
      ...DOCUMENT.feed,
      items: [...DOCUMENT.feed.items, { guid: 'post-new', url: 'https://quiet.example/new', title: 'New' }],
    },
  };

  const res = await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve: async () => withNews });
  assert.equal(res.newItems, 1);
  assert.equal(Number((await q.feedBySlug(db, 'quiet')).fetch_interval_minutes), 60);
});

test('the stored item count tracks what is really there', async () => {
  const feed = await seed();
  await crawlFeed(db, feed, { resolve });
  assert.equal(Number((await q.feedBySlug(db, 'quiet')).item_count), 5);

  // Re-crawling the same document must not inflate it.
  await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve });
  assert.equal(Number((await q.feedBySlug(db, 'quiet')).item_count), 5);
});

test('a failing feed still backs off on its own ladder', async () => {
  const feed = await seed();
  const res = await crawlFeed(db, feed, { resolve: async () => ({ ok: false, error: 'timeout' }) });

  assert.equal(res.ok, false);
  assert.equal(res.newItems, 0);

  const row = await q.feedBySlug(db, 'quiet');
  assert.equal(Number(row.error_count), 1);
  assert.equal(Number(row.fetch_interval_minutes), 60, 'first failure waits an hour');
});
