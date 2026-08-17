import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as a from '../src/accounts.js';
import * as q from '../src/queries.js';

/**
 * Following a subject rather than a publication, and the capability token that
 * lets a reader app poll the result.
 *
 * Kept out of accounts.test.js only because that file is already long; this is
 * the same layer.
 */

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-topic-follows-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a topic and one category of it are two separate follows', async () => {
  const user = await a.findOrCreateUser(db, 'topics@example.com');

  await a.followTopic(db, user.id, 'ai');
  // Twice over: a double submit must not become a constraint error or a second
  // row.
  await a.followTopic(db, user.id, 'ai');
  await a.followTopic(db, user.id, 'ai', 'podcasts');

  assert.equal(await a.isFollowingTopic(db, user.id, 'ai'), true);
  assert.equal(await a.isFollowingTopic(db, user.id, 'ai', 'podcasts'), true);
  assert.equal(await a.isFollowingTopic(db, user.id, 'ai', 'videos'), false);
  assert.equal((await a.followedTopics(db, user.id)).length, 2);

  // Dropping the sub-group leaves the whole topic alone.
  await a.unfollowTopic(db, user.id, 'ai', 'podcasts');
  assert.equal(await a.isFollowingTopic(db, user.id, 'ai', 'podcasts'), false);
  assert.equal(await a.isFollowingTopic(db, user.id, 'ai'), true);

  await a.unfollowTopic(db, user.id, 'ai');
  assert.equal((await a.followedTopics(db, user.id)).length, 0);
});

test('a sub-group is followed the same however it was capitalised', async () => {
  const user = await a.findOrCreateUser(db, 'case@example.com');

  await a.followTopic(db, user.id, 'ai', 'Podcasts');
  assert.equal(await a.isFollowingTopic(db, user.id, 'ai', 'podcasts'), true);
  assert.equal((await a.followedTopics(db, user.id)).length, 1);
});

test('a followed topic carries the spelling its feeds use', async () => {
  const user = await a.findOrCreateUser(db, 'keyword@example.com');
  const feed = await q.insertFeed(db, {
    slug: 'home-lab-blog',
    feed_url: 'https://homelab.example/feed.xml',
    title: 'Home Lab Blog',
  });
  await q.replaceFeedKeywords(db, feed.id, [
    { slug: 'home-lab', keyword: 'home lab', words: 2, count: 9, source: 'content' },
  ]);

  await a.followTopic(db, user.id, 'home-lab');
  const [followed] = await a.followedTopics(db, user.id);
  assert.equal(String(followed.keyword), 'home lab');
});

test('a follow on a topic nothing covers still comes back, named by its slug', async () => {
  // The keyword join is a left join on purpose: a topic whose feeds have all
  // died is still followed, and a row that vanished from the list could never be
  // removed by its owner.
  const user = await a.findOrCreateUser(db, 'orphan@example.com');
  await a.followTopic(db, user.id, 'nobody-writes-about-this');

  const [followed] = await a.followedTopics(db, user.id);
  assert.equal(String(followed.slug), 'nobody-writes-about-this');
  assert.equal(followed.keyword, null);
});

test('follower counts are per topic and per sub-group', async () => {
  const one = await a.findOrCreateUser(db, 'counter-one@example.com');
  const two = await a.findOrCreateUser(db, 'counter-two@example.com');

  await a.followTopic(db, one.id, 'rust');
  await a.followTopic(db, two.id, 'rust');
  await a.followTopic(db, two.id, 'rust', 'podcasts');

  assert.equal(await a.topicFollowerCount(db, 'rust'), 2);
  assert.equal(await a.topicFollowerCount(db, 'rust', 'podcasts'), 1);
});

test('a follow dies with the account that made it', async () => {
  const user = await a.findOrCreateUser(db, 'deleted@example.com');
  await a.followTopic(db, user.id, 'transient');

  await db.execute({ sql: 'delete from users where id = ?', args: [user.id] });
  assert.equal(await a.topicFollowerCount(db, 'transient'), 0);
});

test('a feed token identifies exactly one reader, and rotating retires the old one', async () => {
  const user = await a.findOrCreateUser(db, 'river@example.com');

  assert.equal(await a.feedToken(db, user.id), null);
  // Nothing matches an empty token, or the lookup would find every account that
  // has never asked for one.
  assert.equal(await a.userByFeedToken(db, ''), null);

  await a.setFeedToken(db, user.id, 'token-first');
  assert.equal(await a.feedToken(db, user.id), 'token-first');
  assert.equal(String((await a.userByFeedToken(db, 'token-first')).id), user.id);

  await a.setFeedToken(db, user.id, 'token-second');
  assert.equal(await a.userByFeedToken(db, 'token-first'), null);
  assert.equal(String((await a.userByFeedToken(db, 'token-second')).id), user.id);
});

test('a followed blog river carries everything the merged one needs', async () => {
  // The following page and the personal feed merge these rows with topic rows
  // and hand the result to the same renderers, so the two queries have to agree
  // on their columns.
  const user = await a.findOrCreateUser(db, 'columns@example.com');
  const feed = await q.insertFeed(db, {
    slug: 'columns-blog',
    feed_url: 'https://columns.example/feed.xml',
    title: 'Columns Blog',
  });

  await q.upsertItems(db, feed.id, [
    {
      guid: 'post-1',
      url: 'https://columns.example/post-1',
      title: 'A post',
      summary: 'Something happened.',
      published_at: '2026-06-01T00:00:00.000Z',
    },
  ]);

  await a.follow(db, user.id, feed.id);
  const [row] = await a.followedItems(db, user.id, 10);

  for (const column of ['guid', 'url', 'title', 'published_at', 'feed_slug', 'feed_title']) {
    assert.ok(column in row, `followedItems must select ${column}`);
  }
  // cluster_key is what collapses the same story reached by a blog follow and a
  // topic follow, so its absence would silently stop de-duplication working.
  assert.ok('cluster_key' in row, 'followedItems must select cluster_key');
  assert.ok('category' in row, 'followedItems must select category');
});
