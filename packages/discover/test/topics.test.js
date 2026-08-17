import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, discovery, q } from '@rssamplifier/db';

import { discoverFromOwnTopics } from '../src/topics.js';

/** A database with a topics table already populated. */
async function withTopics(rows) {
  const dir = await mkdtemp(join(tmpdir(), 'rssamp-topics-'));
  const db = connect({ url: `file:${join(dir, 't.db')}` });
  await migrate(db);

  for (const [slug, keyword, feedCount] of rows) {
    await db.execute({
      sql: `insert into topics (slug, keyword, feed_count, refreshed_at) values (?, ?, ?, ?)`,
      args: [slug, keyword, feedCount, new Date().toISOString()],
    });
  }

  return { db, dir };
}

test('the topics searched are subjects, not the words every feed uses', async () => {
  const { db, dir } = await withTopics([
    // What popularity alone selects for, and what the first live run actually
    // searched: the words every blog on earth uses.
    ['one', 'one', 10300],
    ['post', 'post', 7269],
    ['continue-reading', 'continue reading', 2418],
    // Subjects.
    ['home-lab', 'home lab', 40],
    ['open-source', 'open source', 25],
    // A single word cannot be told from a stopword by count, so none are taken.
    ['sourdough', 'sourdough', 9],
    // Below the floor: one blog's own vocabulary.
    ['my-weekly-roundup', 'my weekly roundup', 2],
  ]);

  const keywords = await discovery.unsearchedTopics(db, { limit: 5 });
  assert.deepEqual(keywords, ['home lab', 'open source']);

  await rm(dir, { recursive: true, force: true });
});

test('half-decoded markup never becomes a search term', async () => {
  // These are real rows from the live directory: "rsquo" was the seventh most
  // common topic of all, because every "I&rsquo;ve" contributed one.
  const { db, dir } = await withTopics([
    ['rsquo-ve', 'rsquo ve', 318],
    ['xa-xa-xa', '#xa #xa #xa', 280],
    ['apos-ve', 'apos ve', 201],
    ['https-www', 'https www', 198],
    ['x27-ve', '#x27 ve', 190],
    ['ai-agents', 'ai agents', 284],
  ]);

  assert.deepEqual(await discovery.unsearchedTopics(db, { limit: 10 }), ['ai agents']);

  await rm(dir, { recursive: true, force: true });
});

test('a keyword anybody has already searched is never searched again', async () => {
  const { db, dir } = await withTopics([
    ['home-lab', 'home lab', 40],
    ['open-source', 'open source', 25],
  ]);

  // Somebody ran this one through the form.
  const runId = await discovery.insertRun(db, { keywords: ['home lab'] });
  await discovery.insertKeywords(db, runId, ['home lab']);

  assert.deepEqual(await discovery.unsearchedTopics(db), ['open source']);

  await rm(dir, { recursive: true, force: true });
});

test('without a search key nothing is spent and nothing is queued', async () => {
  const { db, dir } = await withTopics([['home-lab', 'home lab', 40]]);

  let called = false;
  const result = await discoverFromOwnTopics(db, {
    env: {},
    discoverImpl: async () => {
      called = true;
    },
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, 'no-api-key');
  assert.equal(called, false, 'a metered call must not be made without a key');

  await rm(dir, { recursive: true, force: true });
});

test('a directory with nothing new to search says so rather than searching noise', async () => {
  const { db, dir } = await withTopics([['tiny', 'tiny thing', 1]]);

  const result = await discoverFromOwnTopics(db, {
    env: { VALUESERP_API_KEY: 'k' },
    discoverImpl: async () => assert.fail('should not have searched'),
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, 'nothing-new');

  await rm(dir, { recursive: true, force: true });
});

test('a pass queues its keywords and stops, leaving the searching to the poller', async () => {
  const { db, dir } = await withTopics([
    ['home-lab', 'home lab', 40],
    ['open-source', 'open source', 25],
    // Single word: excluded however popular, because a single word cannot be
    // told from a stopword by its count.
    ['e-ink', 'e-ink', 12],
    ['fountain-pens', 'fountain pens', 7],
  ]);

  let passed;
  const result = await discoverFromOwnTopics(db, {
    env: { VALUESERP_API_KEY: 'k' },
    limit: 3,
    discoverImpl: async (_db, keywords, opts) => {
      passed = { keywords, opts };
      opts.onStarted?.('run-1');
    },
  });

  assert.equal(result.ran, true);
  assert.deepEqual(
    result.keywords,
    ['home lab', 'open source', 'fountain pens'],
    'capped, commonest first, single words skipped',
  );
  assert.equal(result.runId, 'run-1');

  // Nothing is searched or checked inline: this runs inside the crawl tick, and
  // a several-minute search there would stall the crawler.
  assert.equal(passed.opts.searchBudgetMs, 0);
  assert.equal(passed.opts.inlineLimit, 0);

  await rm(dir, { recursive: true, force: true });
});

test('topics come from the directory the crawler actually built', async () => {
  // End to end against the real rollup rather than hand-inserted topics: two
  // feeds sharing a keyword is what makes it a topic worth searching.
  const dir = await mkdtemp(join(tmpdir(), 'rssamp-topics-e2e-'));
  const db = connect({ url: `file:${join(dir, 'e.db')}` });
  await migrate(db);

  const a = await q.insertFeed(db, { slug: 'a', feed_url: 'https://a.example/f', title: 'A' });
  const b = await q.insertFeed(db, { slug: 'b', feed_url: 'https://b.example/f', title: 'B' });

  for (const feed of [a, b]) {
    await q.replaceFeedKeywords(db, feed.id, [
      { slug: 'home-lab', keyword: 'home lab', words: 2, count: 5, source: 'content' },
    ]);
  }
  await q.refreshTopics(db);

  assert.deepEqual(await discovery.unsearchedTopics(db, { minFeeds: 2 }), ['home lab']);

  await rm(dir, { recursive: true, force: true });
});
