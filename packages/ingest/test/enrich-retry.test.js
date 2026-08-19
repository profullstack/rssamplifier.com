import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q, authors as a } from '@rssamplifier/db';

import { enrichDue } from '../src/enrich.js';

// A failure is not a miss, and treating them the same is how a publisher on a
// flaky host loses their enrichment for three months over one timeout.

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-retry-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a feed whose site fell over is tried again in days, not in a season', async () => {
  await q.insertFeed(db, {
    slug: 'flaky',
    feed_url: 'https://flaky.example/feed.xml',
    site_url: 'https://flaky.example/',
    title: 'Flaky Blog',
    categories: [],
    kind: 'blog',
    status: 'active',
  });

  const recheckDays = 90;
  const recheckBefore = new Date(Date.now() - recheckDays * 86_400_000).toISOString();

  await enrichDue(db, 5, {
    recheckDays,
    // The shape of a bad afternoon: the host simply does not answer.
    resolve: async () => {
      throw new Error('ETIMEDOUT');
    },
    fetch: async () => {
      throw new Error('ETIMEDOUT');
    },
  });

  // Still stamped, which is what keeps a permanently broken feed from sitting
  // at the head of the queue forever.
  const [row] = (await db.execute('select authors_checked_at from feeds where slug = \'flaky\'')).rows;
  assert.ok(row.authors_checked_at, 'a failure is still recorded');

  // But not due 90 days from now. It comes back within a few days.
  assert.deepEqual(
    await a.dueForAuthors(db, 5, recheckBefore),
    [],
    'not due again immediately, or it would block the queue',
  );

  const inFourDays = new Date(Date.now() + 4 * 86_400_000 - recheckDays * 86_400_000).toISOString();
  const soon = await a.dueForAuthors(db, 5, inFourDays);
  assert.equal(soon.length, 1, 'and it is due again within days rather than in three months');
});

test('the retry stamp is never in the future', async () => {
  // A stamp ahead of now would hide the feed from any pass whose recheck window
  // is shorter than this one's.
  await q.insertFeed(db, {
    slug: 'future',
    feed_url: 'https://future.example/feed.xml',
    title: 'Future Blog',
    categories: [],
    kind: 'blog',
    status: 'active',
  });

  const [feed] = (await db.execute("select id from feeds where slug = 'future'")).rows;
  await a.markAuthorsFailed(db, String(feed.id), { retryDays: 200, recheckDays: 90 });

  const [row] = (await db.execute("select authors_checked_at from feeds where slug = 'future'")).rows;
  assert.ok(
    String(row.authors_checked_at) <= new Date().toISOString(),
    `stamp must not be in the future, got ${row.authors_checked_at}`,
  );
});
