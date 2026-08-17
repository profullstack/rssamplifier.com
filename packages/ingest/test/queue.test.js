import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q } from '@rssamplifier/db';

import { queueFeeds } from '../src/queue.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-queue-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('queueFeeds stores a batch without fetching any of it', async () => {
  const res = await queueFeeds(db, [
    { url: 'https://a.example/feed.xml', title: 'Alpha', siteUrl: 'https://a.example/' },
    { url: 'https://b.example/feed.xml', title: 'Beta' },
  ]);

  assert.equal(res.queued, 2);
  assert.equal(res.skipped, 0);
  assert.equal(res.invalid, 0);

  const alpha = await q.feedByUrl(db, 'https://a.example/feed.xml');
  assert.equal(alpha.title, 'Alpha');
  assert.equal(alpha.slug, 'alpha');
  assert.equal(alpha.site_url, 'https://a.example/');
  assert.equal(alpha.status, 'pending');
});

test('a batch of feeds already in the directory is skipped, not re-added', async () => {
  const res = await queueFeeds(db, [
    { url: 'https://a.example/feed.xml', title: 'Alpha' },
    { url: 'https://c.example/feed.xml', title: 'Gamma' },
  ]);

  assert.equal(res.queued, 1);
  assert.equal(res.skipped, 1);
});

test('a URL repeated inside one batch counts once', async () => {
  const res = await queueFeeds(db, [
    { url: 'https://dup.example/feed.xml', title: 'Dup' },
    { url: 'https://dup.example/feed.xml', title: 'Dup' },
  ]);

  assert.equal(res.queued, 1);
  // The second one is the same outcome as a feed already in the directory, and
  // is reported the same way rather than vanishing from the tally.
  assert.equal(res.skipped, 1);
  assert.equal(res.queued + res.skipped + res.invalid, res.total);
});

test('unusable entries are counted as invalid rather than dropped silently', async () => {
  const res = await queueFeeds(db, [
    { url: 'not a url at all', title: '' },
    { url: '', title: '' },
    { url: 'https://valid.example/feed.xml', title: 'Valid' },
  ]);

  assert.equal(res.queued, 1);
  assert.equal(res.invalid, 2);
});

test('two feeds with the same title in one batch get distinct slugs', async () => {
  // The failure this guards against is silent: insertFeedsBulk says
  // `on conflict do nothing`, so without the slug check the second of these
  // would vanish and the count would still look right.
  const res = await queueFeeds(db, [
    { url: 'https://one.example/feed.xml', title: 'Weeknotes' },
    { url: 'https://two.example/feed.xml', title: 'Weeknotes' },
    { url: 'https://three.example/feed.xml', title: 'Weeknotes' },
  ]);

  assert.equal(res.queued, 3);

  const slugs = await Promise.all(
    ['one', 'two', 'three'].map(async (host) => {
      const row = await q.feedByUrl(db, `https://${host}.example/feed.xml`);
      return row.slug;
    }),
  );

  assert.equal(new Set(slugs).size, 3);
  assert.equal(slugs[0], 'weeknotes');
});

test('a title colliding with an earlier batch is suffixed, not lost', async () => {
  const res = await queueFeeds(db, [{ url: 'https://four.example/feed.xml', title: 'Weeknotes' }]);

  assert.equal(res.queued, 1);
  const row = await q.feedByUrl(db, 'https://four.example/feed.xml');
  assert.notEqual(row.slug, 'weeknotes');
  assert.match(row.slug, /^weeknotes-\d+$/);
});

test('a feed with no title is named after its host', async () => {
  await queueFeeds(db, [{ url: 'https://www.untitled.example/rss' }]);

  const row = await q.feedByUrl(db, 'https://www.untitled.example/rss');
  assert.equal(row.title, 'untitled.example');
});

test('an offset pushes a batch behind everything queued before it', async () => {
  const before = await queueFeeds(db, [{ url: 'https://early.example/feed.xml', title: 'Early' }], {
    ratePerMinute: 60,
  });
  const after = await queueFeeds(db, [{ url: 'https://late.example/feed.xml', title: 'Late' }], {
    offsetMinutes: 120,
    ratePerMinute: 60,
  });

  assert.equal(before.queued, 1);
  assert.equal(after.queued, 1);

  const first = await q.feedByUrl(db, 'https://early.example/feed.xml');
  const second = await q.feedByUrl(db, 'https://late.example/feed.xml');

  const gap = Date.parse(second.next_fetch_at) - Date.parse(first.next_fetch_at);
  // Two hours, give or take the milliseconds between the two inserts.
  assert.ok(gap > 110 * 60_000, `expected the later batch to be pushed out, got ${gap}ms`);
});

test('a whole submission can be queued in pieces and counted as one', async () => {
  const submissionId = 'sub-test-1';
  const entries = Array.from({ length: 120 }, (_, i) => ({
    url: `https://piece${i}.example/feed.xml`,
    title: `Piece ${i}`,
  }));

  let queued = 0;
  for (let at = 0; at < entries.length; at += 25) {
    const res = await queueFeeds(db, entries.slice(at, at + 25), {
      submissionId,
      offsetMinutes: at / 60,
    });
    queued += res.queued;
  }

  assert.equal(queued, 120);

  const progress = await q.submissionProgress(db, submissionId);
  assert.equal(progress.queued, 120);
  assert.equal(progress.waiting, 120);
});

test('a batch of feeds sharing one title costs a fixed number of queries', async () => {
  // The bug this guards is invisible locally and fatal in production. The
  // widening lookup used to fire once per *entry* rather than once per base, so
  // two thousand feeds sharing a title cost two thousand sequential round
  // trips. Against SQLite that is a second; against Turso it is over a minute
  // per batch, spent with the uploader's bar sitting at 100%.
  const entries = Array.from({ length: 400 }, (_, i) => ({
    url: `https://same${i}.example/feed.xml`,
    title: 'Weeknotes',
  }));

  let queries = 0;
  const real = db.execute.bind(db);
  db.execute = (...args) => {
    queries += 1;
    return real(...args);
  };

  try {
    const res = await queueFeeds(db, entries);
    assert.equal(res.queued, 400, 'every feed was queued');
    assert.ok(queries < 20, `${queries} queries for one batch — it is per-entry again`);
  } finally {
    db.execute = real;
  }
});

test('more than 300 feeds sharing a base slug are all kept', async () => {
  // takenSlugs used to say `limit 300`. uniqueSlug takes the first slug the set
  // does not contain, so a truncated set returned one already in use and
  // insertFeedsBulk's `on conflict do nothing` dropped the row in silence.
  const make = (prefix, n) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://${prefix}${i}.example/feed.xml`,
      title: 'Overlap',
    }));

  const first = await queueFeeds(db, make('over-a', 350));
  assert.equal(first.queued, 350);

  // The second batch is where truncation used to bite: the directory already
  // holds more variants of this base than the old limit would return.
  const second = await queueFeeds(db, make('over-b', 200));
  assert.equal(second.queued, 200, 'feeds past the old 300-row limit went missing');

  const { rows } = await db.execute({
    sql: "select count(*) as n, count(distinct slug) as d from feeds where slug like 'overlap%'",
  });
  assert.equal(Number(rows[0].n), 550);
  assert.equal(Number(rows[0].d), 550, 'every one of them kept its own slug');
});
