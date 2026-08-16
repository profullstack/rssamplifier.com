import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q } from '@rssamplifier/db';

import { importFeeds, importOpml } from '../src/import.js';
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
