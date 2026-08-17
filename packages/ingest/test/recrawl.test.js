import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, newId, q } from '@rssamplifier/db';

import { crawlFeed } from '../src/crawl.js';

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
