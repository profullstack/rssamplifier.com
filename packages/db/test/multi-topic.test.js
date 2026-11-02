import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { nowIso } from '../src/client.js';
import { connectTest } from '../src/testdb.js';
import * as q from '../src/queries.js';

/**
 * Three topics that overlap: /topics/business,saas,crypto.
 *
 * `both` is filed under business AND saas, which is the case the union exists
 * for: it must come back once, counted once, and rank on its combined strength.
 */
let db;

const FEEDS = [
  // slug, kind, [topic, count, source]...
  ['biz-tagged', 'blog', [['business', 2, 'category']]],
  ['biz-counted', 'blog', [['business', 9, 'content']]],
  ['both', 'blog', [['business', 4, 'content'], ['saas', 4, 'content']]],
  ['saas-show', 'podcast', [['saas', 3, 'category']]],
  ['coin-blog', 'blog', [['crypto', 1, 'content']]],
];

before(async () => {
  db = await connectTest();

  for (const [slug, kind, topics] of FEEDS) {
    const { id } = await q.insertFeed(db, {
      slug,
      feed_url: `https://${slug}.example/feed.xml`,
      title: slug,
      kind,
    });

    await q.replaceFeedKeywords(
      db,
      id,
      topics.map(([topic, count, source]) => ({
        slug: topic,
        keyword: topic,
        words: 1,
        count,
        source,
      })),
    );

    await q.upsertItems(db, id, [
      {
        guid: `${slug}-1`,
        title: `${slug} post`,
        url: `https://${slug}.example/1`,
        publishedAt: nowIso(),
        audio:
          kind === 'podcast' ? { url: `https://${slug}.example/1.mp3`, type: 'audio/mpeg' } : null,
      },
    ]);
  }
});

after(async () => {
  db.close();
});

test('a one-element list is the single topic, row for row', async () => {
  assert.deepEqual(
    await q.feedsForTopic(db, ['business']),
    await q.feedsForTopic(db, 'business'),
  );
  assert.deepEqual(await q.topicKindCounts(db, ['saas']), await q.topicKindCounts(db, 'saas'));
  assert.deepEqual(
    (await q.itemsForTopic(db, ['business'])).map((i) => i.guid),
    (await q.itemsForTopic(db, 'business')).map((i) => i.guid),
  );
});

test('the single-topic ordering is unchanged: tagged first, then strength', async () => {
  const rows = await q.feedsForTopic(db, 'business');
  assert.deepEqual(
    rows.map((f) => String(f.slug)),
    ['biz-tagged', 'biz-counted', 'both'],
  );
});

test('several topics list their union, each feed once', async () => {
  const rows = await q.feedsForTopic(db, ['business', 'saas', 'crypto']);
  const slugs = rows.map((f) => String(f.slug));

  assert.equal(new Set(slugs).size, slugs.length);
  assert.deepEqual([...slugs].sort(), ['biz-counted', 'biz-tagged', 'both', 'coin-blog', 'saas-show']);

  // Tagged under any topic first; then summed strength, so `both` (4 + 4)
  // outranks nothing it should not and sits right behind biz-counted (9).
  assert.deepEqual(slugs, ['saas-show', 'biz-tagged', 'biz-counted', 'both', 'coin-blog']);

  const both = rows.find((f) => f.slug === 'both');
  assert.equal(Number(both.count), 8);
  assert.equal(both.topics, 'business,saas');
  assert.equal(rows.find((f) => f.slug === 'saas-show').source, 'category');
});

test('the union pages and filters like a single topic', async () => {
  const page2 = await q.feedsForTopic(db, ['business', 'saas', 'crypto'], { limit: 2, offset: 2 });
  assert.deepEqual(
    page2.map((f) => String(f.slug)),
    ['biz-counted', 'both'],
  );

  const podcasts = await q.feedsForTopic(db, ['business', 'saas'], { kinds: ['podcast'] });
  assert.deepEqual(
    podcasts.map((f) => String(f.slug)),
    ['saas-show'],
  );
});

test('the union counts a shared feed once, per category and in total', async () => {
  assert.deepEqual(await q.topicKindCounts(db, ['business', 'saas', 'crypto']), {
    blog: 4,
    podcast: 1,
  });

  const { topics, feedCount } = await q.topicsBySlugs(db, ['crypto', 'business', 'nope', 'saas']);
  assert.equal(feedCount, 5);
  // Known topics only, in the order asked for.
  assert.deepEqual(
    topics.map((t) => [t.slug, t.feedCount]),
    [
      ['crypto', 1],
      ['business', 3],
      ['saas', 2],
    ],
  );
});

test('the union river is every listed topic, newest first, once each', async () => {
  const items = await q.itemsForTopic(db, ['business', 'saas', 'crypto'], { group: false });
  const guids = items.map((i) => String(i.guid));

  assert.equal(new Set(guids).size, guids.length);
  assert.deepEqual([...guids].sort(), FEEDS.map(([slug]) => `${slug}-1`).sort());

  const media = await q.mediaForTopic(db, ['business', 'saas']);
  assert.deepEqual(
    media.map((i) => String(i.guid)),
    ['saas-show-1'],
  );
});

test('a topic list is deduplicated and blanks are dropped', () => {
  assert.deepEqual(q.topicSlugList(['a', 'b', 'a', '']), ['a', 'b']);
  assert.deepEqual(q.topicSlugList('a'), ['a']);
});
