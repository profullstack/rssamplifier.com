import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, newId, nowIso } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as q from '../src/queries.js';
import {
  FeedRemovedError,
  dropRemoved,
  isRemovedUrl,
  listRemovals,
  removalHost,
  removeFeed,
} from '../src/removals.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-removals-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
  // Cascades are the whole mechanism; a file database has them off by default.
  await db.execute('pragma foreign_keys = on');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function addItem(feedId, url) {
  await db.execute({
    sql: `insert into feed_items (id, feed_id, guid, url, title, published_at, created_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
    args: [newId(), feedId, url, url, 'post', nowIso(), nowIso()],
  });
}

test('removalHost keys on the bare host', () => {
  assert.equal(removalHost('https://WWW.Example.com:443/feed'), 'example.com');
  assert.equal(removalHost('https://judith.substack.com/feed'), 'judith.substack.com');
  assert.equal(removalHost('not a url'), null);
});

test('removeFeed deletes the feed, its items and an orphaned author, and records it', async () => {
  const { id } = await q.insertFeed(db, {
    slug: 'potter-substack-com',
    feed_url: 'https://potter.substack.com/feed',
    site_url: 'https://potter.substack.com',
    title: 'Potter',
  });
  await addItem(id, 'https://potter.substack.com/p/one');
  await addItem(id, 'https://potter.substack.com/p/two');

  const authorId = newId();
  await db.execute({
    sql: 'insert into authors (id, slug, identity_key, name, norm_name, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    args: [authorId, 'potter', 'potter', 'Potter', 'potter', nowIso(), nowIso()],
  });
  await db.execute({
    sql: 'insert into feed_authors (feed_id, author_id, created_at) values (?, ?, ?)',
    args: [id, authorId, nowIso()],
  });

  const result = await removeFeed(db, {
    feed_url: 'https://potter.substack.com/feed',
    reason: 'owner asked',
    requested_by: 'potter@example.com',
  });

  assert.equal(result.host, 'potter.substack.com');
  assert.deepEqual(
    result.feeds.map((f) => [f.slug, f.items]),
    [['potter-substack-com', 2]]
  );
  assert.equal(result.authors_removed, 1);
  assert.equal(result.already_recorded, false);

  assert.equal(await q.feedBySlug(db, 'potter-substack-com'), null);
  const { rows: items } = await db.execute({
    sql: 'select count(*) as n from feed_items where feed_id = ?',
    args: [id],
  });
  assert.equal(Number(items[0].n), 0);
  const { rows: authors } = await db.execute({
    sql: 'select count(*) as n from authors where id = ?',
    args: [authorId],
  });
  assert.equal(Number(authors[0].n), 0);

  const removals = await listRemovals(db);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].host, 'potter.substack.com');
  assert.equal(removals[0].items_removed, 2);
  assert.equal(removals[0].requested_by, 'potter@example.com');
});

test('a removed host stays out of every insert path', async () => {
  assert.equal(await isRemovedUrl(db, 'https://potter.substack.com/feed'), true);
  // Another URL on the same publisher's host is the same request.
  assert.equal(await isRemovedUrl(db, 'https://www.potter.substack.com/feed?format=rss'), true);
  assert.equal(await isRemovedUrl(db, 'https://someone-else.substack.com/feed'), false);

  await assert.rejects(
    q.insertFeed(db, {
      slug: 'potter-again',
      feed_url: 'https://potter.substack.com/feed',
      title: 'Potter again',
    }),
    FeedRemovedError
  );

  const inserted = await q.insertFeedsBulk(db, [
    {
      slug: 'potter-bulk',
      feed_url: 'https://potter.substack.com/feed?bulk=1',
      title: 'Potter bulk',
      next_fetch_at: nowIso(),
    },
    {
      slug: 'fine-blog',
      feed_url: 'https://fine.example/feed',
      title: 'Fine',
      next_fetch_at: nowIso(),
    },
  ]);
  assert.equal(inserted, 1, 'only the feed that was not removed went in');
  assert.equal(await q.feedBySlug(db, 'potter-bulk'), null);
  assert.ok(await q.feedBySlug(db, 'fine-blog'));

  const kept = await dropRemoved(db, [
    { feed_url: 'https://potter.substack.com/rss' },
    { feed_url: 'https://fine.example/feed' },
  ]);
  assert.deepEqual(
    kept.map((f) => f.feed_url),
    ['https://fine.example/feed']
  );
});

test('removing again is idempotent and reports nothing to delete', async () => {
  const result = await removeFeed(db, { feed_url: 'https://potter.substack.com/feed' });
  assert.deepEqual(result.feeds, []);
  assert.equal(result.already_recorded, true);
  assert.equal((await listRemovals(db)).length, 1);
});

test('removeFeed refuses something that is not a URL', async () => {
  await assert.rejects(removeFeed(db, { feed_url: 'nope' }), /not a URL/);
});
