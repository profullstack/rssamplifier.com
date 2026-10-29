import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { connectTest } from '../src/testdb.js';
import * as q from '../src/queries.js';

let db;

const DAY = 24 * 60 * 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

before(async () => {
  db = await connectTest();
});

after(async () => {
  db.close();
});

/** `n` crawled feeds read every `minutes`, all due since `dueAgo` ms. */
async function seed(prefix, n, minutes, dueAgo) {
  await q.insertFeedsBulk(
    db,
    Array.from({ length: n }, (_, i) => ({
      slug: `${prefix}-${i}`,
      feed_url: `https://${prefix}-${i}.example/feed.xml`,
      title: `${prefix} ${i}`,
      next_fetch_at: ago(dueAgo),
    })),
  );
  await db.execute({
    sql: `update feeds set fetch_interval_minutes = ?, last_fetched_at = ? where slug like ?`,
    args: [minutes, ago(dueAgo + DAY), `${prefix}-%`],
  });
}

test('a live feed due today is read before a dormant backlog due four days ago', async () => {
  // Production on 2026-10-29: the crawler had stalled 10-24..28, 260k feeds
  // were due, and a weekly show due on the 25th waited behind every quiet blog
  // due on the 24th because the queue was oldest-due-first.
  await seed('dormant', 40, 10_080, 4 * DAY);
  await seed('archived', 40, 129_600, 5 * DAY);
  await seed('weekly-show', 1, 360, DAY / 24);

  const due = await q.dueFeeds(db, 10);
  const slugs = due.map((r) => String(r.slug));

  assert.equal(slugs[0], 'weekly-show-0', 'the live feed comes first');
  assert.equal(due.length, 10, 'and the rest of the batch still drains the backlog');
  assert.ok(slugs.filter((s) => s.startsWith('archived')).length <= 1, 'archived feeds only trickle while others are due');
});

test('with nothing live due, the batch is still filled from the quiet tiers', async () => {
  await db.execute({ sql: `update feeds set next_fetch_at = ? where slug like 'weekly-show-%'`, args: [new Date(Date.now() + DAY).toISOString()] });
  const due = await q.dueFeeds(db, 30);
  assert.equal(due.length, 30);
  assert.equal(new Set(due.map((r) => r.slug)).size, 30, 'no feed twice');
});

test('dueByTier reports each tier', async () => {
  const tiers = await q.dueByTier(db);
  assert.deepEqual(tiers.map((t) => t.tier), ['hot', 'active', 'slow', 'dormant', 'archived']);
  assert.equal(tiers.find((t) => t.tier === 'dormant').due, 40);
  assert.equal(tiers.find((t) => t.tier === 'archived').due, 40);
});

test('requestRefresh puts a feed at the front of its tier', async () => {
  const [row] = (await db.execute({ sql: `select id from feeds where slug = 'dormant-39'`, args: [] })).rows;
  await q.requestRefresh(db, String(row.id));
  await db.execute({ sql: `update feeds set next_fetch_at = ? where slug like 'archived-%'`, args: [new Date(Date.now() + DAY).toISOString()] });
  const due = await q.dueFeeds(db, 1);
  assert.equal(due[0].slug, 'dormant-39');
});
