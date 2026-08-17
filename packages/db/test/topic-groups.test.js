import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, nowIso } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as q from '../src/queries.js';

/**
 * A topic covered by one feed of each of four categories.
 *
 * One fixture for the whole file because every assertion here is a different
 * cut of the same shape, and rebuilding it per test would be four migrations to
 * ask four questions.
 */
let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-groups-'));
  db = connect({ url: `file:${join(dir, 'groups.db')}` });
  await migrate(db);

  for (const [slug, kind] of [
    ['a-blog', 'blog'],
    ['a-show', 'podcast'],
    ['a-label', 'music'],
    ['a-channel', 'video'],
  ]) {
    const { id } = await q.insertFeed(db, {
      slug,
      feed_url: `https://${slug}.example/feed.xml`,
      title: slug,
      kind,
    });

    await q.replaceFeedKeywords(db, id, [
      { slug: 'physics', keyword: 'physics', words: 1, count: 5, source: 'category' },
    ]);

    await q.upsertItems(db, id, [
      {
        guid: `${slug}-1`,
        title: `${slug} post`,
        url: `https://${slug}.example/1`,
        publishedAt: nowIso(),
        // Writing and YouTube channels carry no enclosure, which is what makes
        // them the right control for the playlist query.
        audio:
          kind === 'blog' || kind === 'video'
            ? null
            : { url: `https://${slug}.example/1.mp3`, type: 'audio/mpeg' },
      },
    ]);
  }
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a topic reports how many feeds it has of each category, in one query', async () => {
  assert.deepEqual(await q.topicKindCounts(db, 'physics'), {
    blog: 1,
    podcast: 1,
    music: 1,
    video: 1,
  });
  assert.equal((await q.topicBySlug(db, 'physics')).feedCount, 4);
});

test('a topic with no feeds has no breakdown rather than a zeroed one', async () => {
  assert.deepEqual(await q.topicKindCounts(db, 'nothing-here'), {});
});

test('the listing can be cut to one category', async () => {
  const blogs = await q.feedsForTopic(db, 'physics', { kinds: ['blog'] });
  assert.deepEqual(
    blogs.map((f) => String(f.slug)),
    ['a-blog'],
  );
});

test('the listing can be cut to several categories at once', async () => {
  // The case a single-kind filter could not express, and the reason the queries
  // take a set: "audio" is podcasts and music together.
  const audio = await q.feedsForTopic(db, 'physics', { kinds: ['podcast', 'music'] });
  assert.deepEqual(
    audio.map((f) => String(f.slug)).sort(),
    ['a-label', 'a-show'],
  );
});

test('no filter, and a filter of nonsense, are both the whole topic', async () => {
  assert.equal((await q.feedsForTopic(db, 'physics')).length, 4);
  assert.equal((await q.feedsForTopic(db, 'physics', { kinds: ['elephant'] })).length, 4);
  assert.equal((await q.feedsForTopic(db, 'physics', { kinds: [] })).length, 4);
});

test('the river takes the same filter as the listing', async () => {
  const river = await q.itemsForTopic(db, 'physics', { kinds: ['podcast'] });
  assert.deepEqual(
    river.map((i) => String(i.feed_slug)),
    ['a-show'],
  );

  assert.equal((await q.itemsForTopic(db, 'physics')).length, 4);
});

test('the playlist takes the filter and still carries only what has a file', async () => {
  const playlist = await q.mediaForTopic(db, 'physics', { kinds: ['podcast', 'music'] });
  assert.deepEqual(
    playlist.map((i) => String(i.feed_slug)).sort(),
    ['a-label', 'a-show'],
  );

  // Asked for the blogs, whose items have no enclosure: an empty playlist, not
  // the topic's audio leaking through the filter.
  assert.deepEqual(await q.mediaForTopic(db, 'physics', { kinds: ['blog'] }), []);
});

test('a dead feed leaves its category count behind', async () => {
  const other = await mkdtemp(join(tmpdir(), 'rssamp-groups-dead-'));
  const db2 = connect({ url: `file:${join(other, 'dead.db')}` });
  await migrate(db2);

  const { id } = await q.insertFeed(db2, {
    slug: 'gone',
    feed_url: 'https://gone.example/feed.xml',
    title: 'Gone',
    kind: 'podcast',
  });
  await q.replaceFeedKeywords(db2, id, [
    { slug: 'physics', keyword: 'physics', words: 1, count: 2, source: 'content' },
  ]);

  assert.deepEqual(await q.topicKindCounts(db2, 'physics'), { podcast: 1 });

  await db2.execute("update feeds set status = 'dead' where slug = 'gone'");
  assert.deepEqual(
    await q.topicKindCounts(db2, 'physics'),
    {},
    'a dead feed must not make a sub-group look populated',
  );

  await rm(other, { recursive: true, force: true });
});
