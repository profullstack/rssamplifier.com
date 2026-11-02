import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { nowIso, q } from '@rssamplifier/db';
import { connectTest } from '@rssamplifier/db/src/testdb.js';
import { topicSlug } from '@rssamplifier/feed';

import { MAX_TOPICS, parseTopicList, topicSegment } from '../src/lib/topicSet.js';
import { playerPath } from '../src/lib/player.js';

/**
 * Combined topic views: /topics/business,saas,crypto and every surface that
 * takes a topic. The pure parsing is tested on its own; the rest runs the real
 * route handlers and MCP tools against a throwaway database, because the
 * promise being tested is that one topic answers exactly as it always did and
 * a list answers in the same shape.
 */
let db;
let lib;
let apiRoute;
let feedRoute;
let tools;

before(async () => {
  db = await connectTest();
  const url = new URL(
    process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5439/postgres',
  );
  url.pathname = `/${db.databaseName}`;
  process.env['DATABASE_URL'] = url.toString();
  // No sponsored items in a feed under test: they come from the network.
  process.env['FEED_ADS'] = '0';

  for (const [slug, topics] of [
    ['biz', [['business', 5, 'category']]],
    ['both', [['business', 2, 'content'], ['saas', 2, 'content']]],
    ['saas-only', [['saas', 3, 'content']]],
    ['coins', [['crypto', 1, 'content']]],
  ]) {
    const { id } = await q.insertFeed(db, {
      slug,
      feed_url: `https://${slug}.example/feed.xml`,
      title: slug,
      kind: 'blog',
    });
    await q.replaceFeedKeywords(
      db,
      id,
      // Slugged as the crawler slugs them: "saas" is stored as "saa", exactly as
      // in production, which is why every expectation below says saa.
      topics.map(([topic, count, source]) => ({ slug: topicSlug(topic), keyword: topic, words: 1, count, source })),
    );
    await q.upsertItems(db, id, [
      { guid: `${slug}-1`, title: `${slug} post`, url: `https://${slug}.example/1`, publishedAt: nowIso() },
    ]);
  }

  lib = await import('../src/lib/topicSet.js');
  apiRoute = await import('../src/app/api/topics/[keyword]/route.js');
  feedRoute = await import('../src/app/api/topics/[keyword]/feed/[format]/route.js');
  ({ TOOLS_BY_NAME: tools } = await import('../src/lib/mcp/tools.js'));
});

after(async () => {
  const { db: shared } = await import('../src/lib/db.js');
  shared().close();
  db?.close();
});

const api = async (keyword, query = '') => {
  const res = await apiRoute.GET(new Request(`https://rssamplifier.com/api/topics/${keyword}${query}`), {
    params: Promise.resolve({ keyword }),
  });
  return { status: res.status, body: await res.json() };
};

test('a comma, %2C and spaces all separate topics; repeats collapse', () => {
  assert.deepEqual(parseTopicList('business,saas,crypto'), {
    slugs: ['business', 'saa', 'crypto'],
    list: true,
  });
  assert.deepEqual(parseTopicList('business%2Csaas%2C%20Crypto'), {
    slugs: ['business', 'saa', 'crypto'],
    list: true,
  });
  assert.deepEqual(parseTopicList('SaaS, saas ,,business').slugs, ['saa', 'business']);
});

test('a keyword without a comma is the single topic, normalised as before', () => {
  assert.deepEqual(parseTopicList('Home%20Lab'), { slugs: ['home-lab'], list: false });
});

test('a combined address keeps its commas readable', () => {
  assert.equal(topicSegment('business,saas'), 'business,saas');
  assert.equal(topicSegment('home-lab'), 'home-lab');
  assert.equal(playerPath('business,saas', 'podcasts'), '/topics/business,saas/podcasts/play');
  assert.equal(playerPath('ai'), '/topics/ai/play');
});

test('a single topic answers exactly as it did, with no combined-view fields', async () => {
  const { status, body } = await api('business');
  assert.equal(status, 200);
  assert.equal(body.slug, 'business');
  assert.equal(body.total, 2);
  assert.equal('topics' in body, false);
  assert.equal('unknown' in body, false);
  assert.deepEqual(
    body.feeds.map((f) => f.slug),
    ['biz', 'both'],
  );
  assert.equal('topics' in body.feeds[0], false);
});

test('a list answers in the same shape, for the union, each feed once', async () => {
  const { status, body } = await api('business,saas,crypto', '?limit=10');
  assert.equal(status, 200);
  assert.equal(body.slug, 'business,saa,crypto');
  assert.equal(body.keyword, 'business, saas, crypto');
  // 2 + 2 + 1 feeds, `both` counted once.
  assert.equal(body.total, 4);
  assert.equal(body.page, 'https://rssamplifier.com/topics/business,saa,crypto');
  assert.deepEqual(
    body.topics.map((t) => [t.slug, t.feedCount]),
    [
      ['business', 2],
      ['saa', 2],
      ['crypto', 1],
    ],
  );
  assert.deepEqual(body.unknown, []);
  assert.deepEqual(
    body.feeds.map((f) => f.slug),
    ['biz', 'both', 'saas-only', 'coins'],
  );
  assert.deepEqual(body.feeds[1].topics, ['business', 'saa']);
  assert.equal(body.feeds[1].strength, 4);
});

test('limit, offset and group work on a list as on one topic', async () => {
  const { body } = await api('business,saas', '?limit=1&offset=1&group=blogs');
  assert.equal(body.group, 'blogs');
  assert.equal(body.total, 3);
  assert.deepEqual(
    body.feeds.map((f) => f.slug),
    ['both'],
  );
});

test('unknown topics in a list are named, and the known ones still answer', async () => {
  const { status, body } = await api('business,nope');
  assert.equal(status, 200);
  assert.deepEqual(body.unknown, ['nope']);
  assert.equal(body.total, 2);
});

test('a list of nothing known is a 404; a list too long is a 400', async () => {
  const missing = await api('nope,nada');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.slug, 'nope,nada');

  const many = Array.from({ length: MAX_TOPICS + 1 }, (_, i) => `t${i}`).join(',');
  const tooMany = await api(many);
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error, 'too-many-topics');
});

test('a list that names one topic is that topic, not a copy of it', async () => {
  const { topic } = await lib.resolveTopics(db, 'business,Business');
  assert.equal(topic.slug, 'business');
  assert.equal(topic.multi, undefined);
});

test('the feed of a list is one river across all of its topics', async () => {
  const res = await feedRoute.GET(
    new Request('https://rssamplifier.com/api/topics/business,saas,crypto/feed/json'),
    { params: Promise.resolve({ keyword: 'business,saas,crypto', format: 'json' }) },
  );
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.deepEqual(
    doc.items.map((i) => i.id).sort(),
    ['biz-1', 'both-1', 'coins-1', 'saas-only-1'],
  );
  assert.match(doc.home_page_url, /\/topics\/business,saa,crypto$/);
});

test('the MCP topic tools take a comma list', async () => {
  const listed = await tools.get('get_topic').run({ keyword: 'business, saas' });
  assert.equal(listed.total, 3);
  assert.deepEqual(
    listed.topics.map((t) => t.slug),
    ['business', 'saa'],
  );

  const one = await tools.get('get_topic').run({ keyword: 'business' });
  assert.equal(one.total, 2);
  assert.equal('topics' in one, false);

  const posts = await tools.get('topic_posts').run({ keyword: 'saas,crypto' });
  assert.deepEqual(
    posts.posts.map((p) => p.feed).sort(),
    ['both', 'coins', 'saas-only'],
  );
});
