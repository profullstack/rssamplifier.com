import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q, social } from '@rssamplifier/db';
import { normalizeXFeed, xSource } from '@rssamplifier/social';

import { crawlFeed } from '../src/crawl.js';
import { submitOne } from '../src/submit.js';
import { SOCIAL_MIN_INTERVAL, MIN_INTERVAL } from '../src/cadence.js';

/**
 * The seam where a provider-collected source meets the ordinary crawler.
 *
 * The claim this whole design rests on is that an X source is a feed like any
 * other from the moment it is collected — same dedupe, same scheduling, same
 * storage, same everything downstream. These tests are that claim written down,
 * because it is the sort of thing that is true when it is written and quietly
 * stops being true two refactors later.
 *
 * The other half is what a *failure* must not do. `markCrawlFailure` retires a
 * feed after ten consecutive failures, so anything that mistakes a rate limit,
 * a provider outage or a missing runtime for a broken source would delete the
 * whole X directory over an afternoon and leave no clue why.
 */

let dir;
let db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rsa-social-crawl-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** @param {string[]} ids */
function xPosts(ids) {
  return ids.map((id, index) => ({
    id,
    url: `https://x.com/OpenAI/status/${id}`,
    text: `Post ${id}`,
    createdAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
    author: { username: 'OpenAI', displayName: 'OpenAI Research' },
  }));
}

/** A stand-in for `fetchXSource`, returning the same contract. */
function collector(ids) {
  return async (feed) => ({
    ok: true,
    feedUrl: feed.feed_url,
    feed: normalizeXFeed(xPosts(ids), {
      spec: { mode: 'user', username: 'OpenAI' },
      url: String(feed.feed_url),
      displayName: 'OpenAI Research',
    }),
  });
}

/** Create the row the crawler would be handed, and read it back. */
async function seedXSource() {
  const source = xSource('@OpenAI');
  const stored = await social.upsertSocialSource(db, {
    network: 'x',
    ref: source.ref,
    slug: source.slug,
    title: source.title,
    feedUrl: source.url,
    siteUrl: source.url,
  });

  const { rows } = await db.execute({
    sql: 'select * from feeds where id = ?',
    args: [stored.id],
  });
  return rows[0];
}

test('an X source is collected through the provider, never fetched', async () => {
  const feed = await seedXSource();
  let resolved = 0;

  const result = await crawlFeed(db, feed, {
    x: collector(['1', '2', '3']),
    xRuntime: {},
    // If either of these is ever reached, the dispatch is wrong: there is no
    // document at https://x.com/OpenAI to fetch or to scrape.
    resolve: async () => {
      resolved += 1;
      throw new Error('the ordinary fetch must never see an X source');
    },
    scrape: async () => {
      resolved += 1;
      throw new Error('the scraper must never see an X source');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.newItems, 3);
  assert.equal(resolved, 0);

  const items = await q.itemsForFeed(db, String(feed.id), 50);
  assert.deepEqual(
    items.map((row) => row.guid).sort(),
    ['x:1', 'x:2', 'x:3'],
  );
});

test('the same posts arriving again are stored once (AC-3)', async () => {
  const feed = await seedXSource();

  await crawlFeed(db, feed, { x: collector(['1', '2', '3']), xRuntime: {} });

  const { rows: after } = await db.execute({
    sql: 'select * from feeds where id = ?',
    args: [feed.id],
  });

  const second = await crawlFeed(db, after[0], {
    x: collector(['1', '2', '3', '4']),
    xRuntime: {},
  });

  assert.equal(second.newItems, 1);
  const items = await q.itemsForFeed(db, String(feed.id), 50);
  assert.equal(items.length, 4);
});

test('an X source polls on the five-minute floor, not the hourly one (§17)', async () => {
  const feed = await seedXSource();

  // Posts an hour apart, which on the ordinary floor would still round up to 60.
  await crawlFeed(db, feed, { x: collector(['1', '2', '3']), xRuntime: {} });

  const { rows } = await db.execute({
    sql: 'select fetch_interval_minutes from feeds where id = ?',
    args: [feed.id],
  });

  const interval = Number(rows[0].fetch_interval_minutes);
  assert.ok(interval >= SOCIAL_MIN_INTERVAL, `interval ${interval}`);
  assert.ok(interval < MIN_INTERVAL, `an X source should be able to go below ${MIN_INTERVAL}`);
});

test('a rate limit moves the schedule and touches no health column (§16)', async () => {
  const feed = await seedXSource();
  await crawlFeed(db, feed, { x: collector(['1', '2']), xRuntime: {} });

  const before = (
    await db.execute({ sql: 'select * from feeds where id = ?', args: [feed.id] })
  ).rows[0];

  const result = await crawlFeed(db, before, {
    xRuntime: {},
    x: async () => ({ ok: false, throttled: true, retryAfter: 300, error: 'rate-limited' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.throttled, true);

  const after = (await db.execute({ sql: 'select * from feeds where id = ?', args: [feed.id] }))
    .rows[0];

  // The three columns that would eventually retire the feed.
  assert.equal(Number(after.error_count), Number(before.error_count));
  assert.equal(after.status, before.status);
  assert.equal(after.last_success_at, before.last_success_at);

  // And the items are exactly where they were — which is the whole of the
  // stale-cache fallback (§40, AC-5).
  const items = await q.itemsForFeed(db, String(feed.id), 50);
  assert.equal(items.length, 2);
});

test('no social runtime is a reschedule, not a verdict on the source', async () => {
  const feed = await seedXSource();

  const result = await crawlFeed(db, feed, {});

  assert.equal(result.ok, false);
  assert.equal(result.throttled, true);
  assert.equal(result.error, 'social-runtime-unavailable');

  const after = (await db.execute({ sql: 'select * from feeds where id = ?', args: [feed.id] }))
    .rows[0];
  assert.equal(Number(after.error_count), 0);
  assert.notEqual(after.status, 'dead');
});

test('the crawler is handed the columns it needs to dispatch on', async () => {
  await seedXSource();
  const due = await q.dueFeeds(db, 10);
  const row = due.find((feed) => feed.social_ref === 'x:user:openai');

  assert.ok(row, 'an X source must appear in the due queue');
  assert.equal(row.social_network, 'x');
  assert.ok('social_config' in row);
});

test('an ordinary feed is untouched by any of this', async () => {
  const { id } = await q.insertFeed(db, {
    slug: 'a-blog',
    feed_url: 'https://example.com/feed.xml',
    title: 'A blog',
  });

  const { rows } = await db.execute({ sql: 'select * from feeds where id = ?', args: [id] });

  let asked = 0;
  const result = await crawlFeed(db, rows[0], {
    xRuntime: {},
    x: async () => {
      throw new Error('the X collector must never see an ordinary feed');
    },
    resolve: async () => {
      asked += 1;
      return {
        ok: true,
        feedUrl: 'https://example.com/feed.xml',
        feed: {
          title: 'A blog',
          description: '',
          siteUrl: 'https://example.com',
          categories: [],
          kind: 'blog',
          items: [
            {
              guid: 'p1',
              url: 'https://example.com/p1',
              title: 'A post',
              summary: '',
              contentHtml: '',
              publishedAt: new Date().toISOString(),
              categories: [],
              audio: null,
            },
          ],
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(asked, 1);
});

test('submitting an X URL creates one source however it is spelled (§38)', async () => {
  const first = await submitOne(db, 'https://twitter.com/OpenAI');
  const second = await submitOne(db, '@OpenAI');
  const third = await submitOne(db, 'https://x.com/openai/');

  assert.equal(first.ok, true);
  assert.equal(first.existing, false);
  assert.equal(second.existing, true);
  assert.equal(third.existing, true);
  assert.equal(second.slug, first.slug);

  // And the caller is told where it lives, so a redirect lands on /x/OpenAI
  // rather than on the slug the namespace exists to replace.
  assert.equal(first.path, '/x/OpenAI');

  const { rows } = await db.execute("select count(*) as n from feeds where social_network = 'x'");
  assert.equal(Number(rows[0].n), 1);
});

test('submitting a subreddit files it under Reddit rather than among the blogs', async () => {
  const result = await submitOne(db, 'https://www.reddit.com/r/programming/.rss');

  assert.equal(result.ok, true);
  assert.equal(result.path, '/r/programming');

  const row = await social.feedBySocialRef(db, 'r:sub:programming');
  assert.ok(row);
  assert.equal(row.social_network, 'reddit');
  // Nothing was fetched: a public endpoint must not be a way to make our
  // upstream do work (§37). The poller collects it on its next tick.
  assert.equal(row.status, 'pending');
});
