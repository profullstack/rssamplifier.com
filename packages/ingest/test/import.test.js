import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q } from '@rssamplifier/db';

import { importFeeds, importOpml } from '../src/import.js';
import { submitCatalogue } from '../src/submit.js';
import { nextIntervalMinutes, groupByHost } from '../src/crawl.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-import-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('importFeeds stores catalogue rows without fetching them', async () => {
  const res = await importFeeds(db, [
    { url: 'https://a.example/feed.xml', title: 'Alpha', siteUrl: 'https://a.example/' },
    { url: 'https://b.example/feed.xml', title: 'Beta' },
  ]);

  assert.equal(res.inserted, 2);
  assert.equal(res.skipped, 0);

  const alpha = await q.feedByUrl(db, 'https://a.example/feed.xml');
  assert.equal(alpha.title, 'Alpha');
  assert.equal(alpha.slug, 'alpha');
  assert.equal(alpha.site_url, 'https://a.example/');
  // Pending, not active: nothing has been fetched, so the row is a promise to
  // crawl rather than a claim about a live feed.
  assert.equal(alpha.status, 'pending');
  assert.equal(alpha.item_count, 0);
});

test('importFeeds is idempotent — a re-run inserts nothing', async () => {
  const entries = [{ url: 'https://a.example/feed.xml', title: 'Alpha' }];
  const res = await importFeeds(db, entries);

  assert.equal(res.inserted, 0);
  assert.equal(res.skipped, 1);
});

test('importFeeds gives colliding titles distinct slugs', async () => {
  await importFeeds(db, [
    { url: 'https://c.example/feed.xml', title: 'Same Name' },
    { url: 'https://d.example/feed.xml', title: 'Same Name' },
  ]);

  const first = await q.feedByUrl(db, 'https://c.example/feed.xml');
  const second = await q.feedByUrl(db, 'https://d.example/feed.xml');

  assert.notEqual(first.slug, second.slug);
  assert.equal(first.slug, 'same-name');
  assert.equal(second.slug, 'same-name-2');
});

test('importFeeds falls back to the hostname when a catalogue has no title', async () => {
  await importFeeds(db, [{ url: 'https://www.untitled.example/atom', title: '' }]);

  const row = await q.feedByUrl(db, 'https://www.untitled.example/atom');
  assert.equal(row.title, 'untitled.example');
  assert.equal(row.slug, 'untitled-example');
});

test('importFeeds rejects unusable URLs instead of storing them', async () => {
  const res = await importFeeds(db, [{ url: 'not a url', title: 'Nope' }, { url: '' }]);

  assert.equal(res.inserted, 0);
  assert.equal(res.invalid, 2);
});

test('importFeeds spreads next_fetch_at across the window', async () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({
    url: `https://spread-${i}.example/feed.xml`,
    title: `Spread ${i}`,
  }));

  await importFeeds(db, entries, { spreadMinutes: 60 });

  const { rows } = await db.execute(
    "select next_fetch_at from feeds where slug like 'spread-%' order by next_fetch_at",
  );
  const first = Date.parse(String(rows[0].next_fetch_at));
  const last = Date.parse(String(rows[rows.length - 1].next_fetch_at));

  // 20 feeds over a 60-minute window: the last is due well after the first, and
  // none is pushed past the end of the window.
  assert.ok(last > first, 'schedule should be spread, not simultaneous');
  assert.ok(last - first <= 60 * 60_000, 'spread must stay inside the window');
});

test('importOpml reads xmlUrl and htmlUrl out of a subscription list', async () => {
  const xml = `<?xml version="1.0"?>
<opml version="2.0"><body>
  <outline text="Folder">
    <outline type="rss" title="Nested Blog"
             xmlUrl="https://nested.example/feed" htmlUrl="https://nested.example/" />
  </outline>
</body></opml>`;

  const res = await importOpml(db, xml);
  assert.equal(res.inserted, 1);

  const row = await q.feedByUrl(db, 'https://nested.example/feed');
  assert.equal(row.title, 'Nested Blog');
  assert.equal(row.site_url, 'https://nested.example/');
});

test('nextIntervalMinutes backs off quiet feeds and rushes active ones', () => {
  // A feed that published goes straight back to the floor.
  assert.equal(nextIntervalMinutes(3, 1440), 60);
  // A quiet one doubles…
  assert.equal(nextIntervalMinutes(0, 60), 120);
  assert.equal(nextIntervalMinutes(0, 120), 240);
  // …up to a day, and no further.
  assert.equal(nextIntervalMinutes(0, 1440), 1440);
  assert.equal(nextIntervalMinutes(0, undefined), 120);
});

test('submitCatalogue queues everything past the inline limit', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({
    url: `https://queued-${i}.example/feed.xml`,
    title: `Queued ${i}`,
  }));

  // inlineLimit 0 keeps the test off the network entirely: nothing is resolved,
  // everything is queued, which is the half of the behaviour under test.
  const res = await submitCatalogue(db, entries, {
    inlineLimit: 0,
    submissionId: 'submission-under-test',
  });

  assert.equal(res.accepted.length, 0);
  assert.equal(res.queued, 5);
  assert.equal(res.total, 5);

  const progress = await q.submissionProgress(db, 'submission-under-test');
  assert.equal(progress.queued, 5);
  assert.equal(progress.waiting, 5);
  assert.equal(progress.crawled, 0);
});

test('the queue is durable before any fetching starts', async () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({
    url: `https://ordered-${i}.example/feed.xml`,
    title: `Ordered ${i}`,
  }));

  /** @type {number|null} */
  let queuedAtCallback = null;
  /** @type {number|null} */
  let rowsWhenCalled = null;

  await submitCatalogue(db, entries, {
    inlineLimit: 0,
    submissionId: 'submission-ordering',
    onQueued: (n) => {
      queuedAtCallback = n;
    },
  });

  // The callback fires with the queue already written, which is what lets the
  // web route answer a large upload without waiting for the fetching half.
  assert.equal(queuedAtCallback, 4, 'onQueued reports how many were queued');

  const progress = await q.submissionProgress(db, 'submission-ordering');
  assert.equal(progress.queued, 4);
  rowsWhenCalled = progress.waiting;
  assert.equal(rowsWhenCalled, 4, 'and the rows really are there, not merely counted');
});

test('onQueued fires even when there is no tail to queue', async () => {
  let called = 0;
  let reported = -1;

  // No entries at all: nothing to fetch and nothing to queue, but a caller
  // waiting on this signal must still be released or its request would hang.
  await submitCatalogue(db, [], {
    inlineLimit: 0,
    submissionId: 'submission-empty',
    onQueued: (n) => {
      called += 1;
      reported = n;
    },
  });

  assert.equal(called, 1);
  assert.equal(reported, 0);
});

test('completeSubmission fills in the tallies the insert left at zero', async () => {
  await q.insertSubmission(db, { id: 'submission-two-phase', kind: 'opml', raw_input: 'x' });

  const before = await q.submissionById(db, 'submission-two-phase');
  assert.equal(Number(before.accepted_count), 0);
  assert.equal(before.notify_email, null, 'no address until the work is done');

  await q.completeSubmission(db, 'submission-two-phase', {
    accepted_count: 3,
    rejected_count: 1,
    queued_count: 9,
    errors: [{ url: 'https://bad.example', error: 'timeout' }],
    notify_email: 'someone@example.com',
  });

  const after = await q.submissionById(db, 'submission-two-phase');
  assert.equal(Number(after.accepted_count), 3);
  assert.equal(Number(after.rejected_count), 1);
  assert.equal(Number(after.queued_count), 9);
  assert.equal(String(after.notify_email), 'someone@example.com');
  assert.deepEqual(JSON.parse(String(after.errors)), [
    { url: 'https://bad.example', error: 'timeout' },
  ]);
});

test('a submission is only owed an email once nothing is still pending', async () => {
  await q.insertSubmission(db, {
    id: 'submission-awaiting',
    kind: 'opml',
    accepted_count: 0,
    queued_count: 2,
    notify_email: 'someone@example.com',
  });

  await submitCatalogue(
    db,
    [
      { url: 'https://notify-a.example/feed.xml', title: 'Notify A' },
      { url: 'https://notify-b.example/feed.xml', title: 'Notify B' },
    ],
    { inlineLimit: 0, submissionId: 'submission-awaiting' },
  );

  // Both feeds are still pending, so there is nothing to announce yet.
  let due = await q.submissionsAwaitingNotice(db);
  assert.equal(
    due.find((r) => r.id === 'submission-awaiting'),
    undefined,
  );

  await db.execute(
    "update feeds set status = 'active' where submission_id = 'submission-awaiting'",
  );

  due = await q.submissionsAwaitingNotice(db);
  assert.ok(due.some((r) => r.id === 'submission-awaiting'), 'drained queue should be notifiable');

  // And once told, never again.
  await q.markSubmissionNotified(db, 'submission-awaiting');
  due = await q.submissionsAwaitingNotice(db);
  assert.equal(
    due.find((r) => r.id === 'submission-awaiting'),
    undefined,
  );
});

test('groupByHost keeps one queue per host so a host is never hit in parallel', () => {
  const groups = groupByHost([
    { feed_url: 'https://x.example/a.xml' },
    { feed_url: 'https://y.example/b.xml' },
    { feed_url: 'https://x.example/c.xml' },
  ]);

  assert.equal(groups.length, 2);
  const x = groups.find((g) => g[0].feed_url.includes('x.example'));
  assert.equal(x.length, 2);
});
