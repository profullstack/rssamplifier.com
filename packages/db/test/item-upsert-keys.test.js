import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { q, traffic } from '../index.js';
import { storedGuid } from '../src/queries.js';
import { connectTest } from '../src/testdb.js';

let db;

before(async () => {
  db = await connectTest();
});

after(async () => {
  db.close();
});

async function feed(slug) {
  return q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example/feed.xml`,
    site_url: `https://${slug}.example/`,
    title: `${slug} blog`,
    kind: 'blog',
    status: 'active',
  });
}

test('a feed that repeats a guid is stored once, keeping the newest copy', async () => {
  const f = await feed('repeats');
  await q.upsertItems(db, String(f.id), [
    { guid: 'dup', title: 'Old copy', publishedAt: '2026-01-01T00:00:00.000Z' },
    { guid: 'other', title: 'Other', publishedAt: '2026-02-01T00:00:00.000Z' },
    { guid: 'dup', title: 'New copy', publishedAt: '2026-03-01T00:00:00.000Z' },
  ]);
  // Re-crawl with the same duplicates: the conflict path must not trip either.
  await q.upsertItems(db, String(f.id), [
    { guid: 'dup', title: 'Old copy', imageUrl: 'https://x.example/a.png', publishedAt: '2026-01-01T00:00:00.000Z' },
    { guid: 'dup', title: 'New copy', imageUrl: 'https://x.example/b.png', publishedAt: '2026-03-01T00:00:00.000Z' },
  ]);

  const { rows } = await db.execute({
    sql: 'select guid, title, image_url from feed_items where feed_id = ? order by guid',
    args: [String(f.id)],
  });
  assert.deepEqual(
    rows.map((r) => [r.guid, r.title, r.image_url]),
    [
      ['dup', 'New copy', 'https://x.example/b.png'],
      ['other', 'Other', null],
    ],
  );
});

test('a guid too long to index is stored hashed and found by its raw form', async () => {
  const f = await feed('longguid');
  const raw = 'x'.repeat(5000);
  await q.upsertItems(db, String(f.id), [{ guid: raw, title: 'Long', publishedAt: '2026-01-01T00:00:00.000Z' }]);
  await q.upsertItems(db, String(f.id), [{ guid: raw, title: 'Long', publishedAt: '2026-01-01T00:00:00.000Z' }]);

  const stored = storedGuid(raw);
  assert.match(stored, /^sha256:[0-9a-f]{64}$/);
  assert.equal(storedGuid('short'), 'short');
  assert.equal((await q.itemByGuid(db, String(f.id), raw))?.guid, stored);
  assert.equal((await q.itemByGuid(db, String(f.id), stored))?.title, 'Long');
});

test('traffic rows fold in whatever order the buffer holds them', async () => {
  const rows = [
    { hour: '2026-10-21T13', agent: 'b', bucket: 'read', tier: 'anon', hits: 1 },
    { hour: '2026-10-21T13', agent: 'a', bucket: 'read', tier: 'anon', hits: 2 },
  ];
  await traffic.recordTraffic(db, rows);
  await traffic.recordTraffic(db, rows.slice().reverse());
  const { rows: got } = await db.execute('select agent, hits from traffic_hourly order by agent');
  assert.deepEqual(got.map((r) => [r.agent, r.hits]), [['a', 4], ['b', 2]]);
});
