import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as q from '../src/queries.js';

let dir;
let db;

/** An hour ago, a day ago, and so on — the backlog is always older than `now`. */
const ago = (ms) => new Date(Date.now() - ms).toISOString();

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-express-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a hand-submitted feed is crawled before a backlog that is older than it', async () => {
  // The shape production is actually in: a great many feeds from a bulk upload,
  // every one of them overdue, and one blog somebody just submitted. Ordering
  // by next_fetch_at alone puts the submission last, because it is the newest
  // thing in the queue and the queue is sorted oldest-first.
  await q.insertFeedsBulk(
    db,
    Array.from({ length: 30 }, (_, i) => ({
      slug: `backlog-${i}`,
      feed_url: `https://backlog-${i}.example/feed.xml`,
      title: `Backlog ${i}`,
      next_fetch_at: ago(30 * 24 * 60 * 60_000),
    })),
  );

  await q.insertFeedsBulk(db, [
    {
      slug: 'hand-submitted',
      feed_url: 'https://hand-submitted.example/feed.xml',
      title: 'Hand Submitted',
      next_fetch_at: ago(1_000),
      priority: 1,
    },
  ]);

  const due = await q.dueFeeds(db, 10);

  assert.equal(due[0].slug, 'hand-submitted', 'the submission is first, not 30 feeds later');
  assert.equal(due.length, 10, 'and the rest of the tick is still the backlog');
});

test('the same feed is never handed out twice in one tick', async () => {
  const due = await q.dueFeeds(db, 10);
  const slugs = due.map((r) => String(r.slug));

  assert.equal(new Set(slugs).size, slugs.length, 'no feed appears in both lanes');
});

test('the express lane cannot take more than half a tick', async () => {
  await q.insertFeedsBulk(
    db,
    Array.from({ length: 20 }, (_, i) => ({
      slug: `expedited-${i}`,
      feed_url: `https://expedited-${i}.example/feed.xml`,
      title: `Expedited ${i}`,
      next_fetch_at: ago(1_000),
      priority: 1,
    })),
  );

  // Every feed currently in the lane, not just the twenty above: the feed the
  // first test submitted is still waiting in it and is just as expedited.
  const waiting = new Set((await q.expressFeeds(db, 100)).map((r) => String(r.slug)));
  assert.ok(waiting.size > 5, 'more want the lane than the lane will give them');

  const due = await q.dueFeeds(db, 10);
  const expedited = due.filter((r) => waiting.has(String(r.slug))).length;

  // Five of ten, and the backlog keeps the other five. A flood of submissions
  // must not be able to stop the directory draining.
  assert.equal(expedited, 5);
  assert.equal(due.length, 10);
});

test('a feed leaves the express lane after one crawl attempt, success or failure', async () => {
  const before = await q.expressFeeds(db, 100);
  assert.ok(before.length > 0, 'the lane has feeds in it to begin with');

  // Not "priority is cleared" — nothing clears it. The lane is defined by
  // last_fetched_at being null, and the crawler writes that column whether the
  // fetch worked or not, so one attempt is all any feed ever gets.
  await db.execute({
    sql: 'update feeds set last_fetched_at = ? where priority > 0',
    args: [new Date().toISOString()],
  });

  const after = await q.expressFeeds(db, 100);
  assert.equal(after.length, 0, 'crawled once, and back in the ordinary queue');
});

test('a dead feed is not expedited, however it was submitted', async () => {
  await q.insertFeedsBulk(db, [
    {
      slug: 'dead-express',
      feed_url: 'https://dead-express.example/feed.xml',
      title: 'Dead Express',
      next_fetch_at: ago(1_000),
      priority: 1,
    },
  ]);

  await db.execute("update feeds set status = 'dead' where slug = 'dead-express'");

  const express = await q.expressFeeds(db, 100);
  assert.equal(
    express.find((r) => String(r.slug) === 'dead-express'),
    undefined,
  );
});

test('an imported feed is queued at priority zero', async () => {
  await q.insertFeedsBulk(db, [
    {
      slug: 'from-an-import',
      feed_url: 'https://from-an-import.example/feed.xml',
      title: 'From An Import',
      next_fetch_at: ago(1_000),
    },
  ]);

  const { rows } = await db.execute({
    sql: 'select priority from feeds where slug = ?',
    args: ['from-an-import'],
  });

  assert.equal(Number(rows[0].priority), 0, 'an upload does not buy its way up the queue');
});
