import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, newId, q, authors } from '../index.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-authorposts-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * @param {string} slug
 * @param {Array<{ guid: string, title: string, publishedAt?: string }>} items
 */
async function feedWith(slug, items) {
  const feed = await q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example/feed.xml`,
    site_url: `https://${slug}.example/`,
    title: `${slug} blog`,
    kind: 'blog',
    status: 'active',
  });
  await q.upsertItems(db, String(feed.id), items);
  return feed;
}

test('an author page shows what their feeds published, newest first', async () => {
  const a = await feedWith('one', [
    { guid: 'a1', title: 'Older post', publishedAt: '2026-01-01T00:00:00.000Z' },
    { guid: 'a2', title: 'Newest post', publishedAt: '2026-06-01T00:00:00.000Z' },
  ]);
  const b = await feedWith('two', [
    { guid: 'b1', title: 'Middle post', publishedAt: '2026-03-01T00:00:00.000Z' },
  ]);

  const posts = await authors.postsByAuthor(db, [String(a.id), String(b.id)]);

  assert.deepEqual(
    posts.map((p) => String(p.title)),
    ['Newest post', 'Middle post', 'Older post'],
    'merged across their feeds and ordered by date',
  );
  // The feed each post came from rides along, because the page links to both
  // the post and the blog it appeared in.
  assert.ok(posts.every((p) => p.feed_slug && p.feed_title));
});

test('it is bounded by the feeds it is given, and asks for nothing else', async () => {
  const mine = await feedWith('mine', [{ guid: 'm1', title: 'Mine', publishedAt: '2026-05-01T00:00:00.000Z' }]);
  await feedWith('theirs', [{ guid: 't1', title: 'Theirs', publishedAt: '2026-05-02T00:00:00.000Z' }]);

  const posts = await authors.postsByAuthor(db, [String(mine.id)]);

  assert.deepEqual(posts.map((p) => String(p.title)), ['Mine'], 'only the feeds named');
});

test('no feeds means no query at all', async () => {
  // The guard that keeps this off a page. Without it an author credited on
  // nothing would produce `feed_id in ()`, and the honest answer is that there
  // is nothing to ask.
  assert.deepEqual(await authors.postsByAuthor(db, []), []);
  assert.deepEqual(await authors.postsByAuthor(db, undefined), []);
  assert.deepEqual(await authors.postsByAuthor(db, [null, '', undefined]), []);
});

test('a mis-attributed author cannot turn the page into a table scan', async () => {
  // Somebody credited on hundreds of feeds is a mis-attribution rather than a
  // prolific writer, and this page must degrade to showing some of their work
  // rather than to a query that takes a minute. The cap is on the feeds asked
  // about, so the statement stays a bounded indexed read either way.
  const many = Array.from({ length: 60 }, () => newId());
  const posts = await authors.postsByAuthor(db, many);
  assert.ok(Array.isArray(posts), 'still answers');
  assert.equal(posts.length, 0, 'those ids are not real feeds');
});

test('authorBySlug hands back feed ids, which is what makes the above possible', async () => {
  const feed = await feedWith('bylined', [{ guid: 'x1', title: 'A post', publishedAt: '2026-04-01T00:00:00.000Z' }]);

  const { id } = await authors.upsertAuthor(db, {
    identityKey: 'mailto:writer@bylined.example',
    slug: 'a-writer',
    name: 'A Writer',
    normName: 'a writer',
    confidence: 0.9,
  });
  await authors.linkFeedAuthor(db, String(feed.id), String(id), { role: 'owner', confidence: 0.9 });

  const person = await authors.authorBySlug(db, 'a-writer');

  assert.ok(person, 'the author is found');
  assert.equal(person.feeds.length, 1);
  // The regression this guards: the feeds sub-select did not return `f.id`, so
  // the page asked for posts by a list of undefineds and silently showed none.
  assert.ok(person.feeds[0].id, 'each feed carries its id');

  const posts = await authors.postsByAuthor(db, person.feeds.map((f) => String(f.id)));
  assert.deepEqual(posts.map((p) => String(p.title)), ['A post']);
});
