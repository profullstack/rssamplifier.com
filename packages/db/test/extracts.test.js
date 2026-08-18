import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as q from '../src/queries.js';
import * as e from '../src/extracts.js';

let dir;
let db;
let itemId;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-extracts-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);

  const feed = await q.insertFeed(db, {
    slug: 'latest-from-musicradar',
    feed_url: 'https://www.musicradar.com/feed',
    site_url: 'https://www.musicradar.com/',
    title: 'Latest from MusicRadar',
    language: 'en',
  });

  await q.upsertItems(db, String(feed.id), [
    {
      guid: 'urn:musicradar:1',
      url: 'https://www.musicradar.com/artists/def-leppard-hysteria',
      title: 'Why Def Leppard could not make Hysteria with Jim Steinman',
      summary: 'The food budget for the Steinman sessions…',
    },
  ]);

  const item = await q.itemByGuid(db, String(feed.id), 'urn:musicradar:1');
  itemId = String(item.id);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a post nobody has read yet has nothing stored, and is due a fetch', async () => {
  assert.equal(await e.forItem(db, itemId), null);
  assert.equal(e.shouldFetch(null), true);
});

test('an extracted article reads back whole', async () => {
  await e.save(db, {
    itemId,
    url: 'https://www.musicradar.com/artists/def-leppard-hysteria',
    status: 'ok',
    article: {
      title: 'Why Def Leppard could not make Hysteria with Jim Steinman',
      byline: 'Paul Elliott',
      excerpt: 'The food budget for the Steinman sessions…',
      siteName: 'MusicRadar',
      html: '<p>Def Leppard were shooting for the stars.</p>',
      length: 11167,
    },
  });

  const stored = await e.forItem(db, itemId);
  assert.equal(stored.status, 'ok');
  assert.equal(stored.byline, 'Paul Elliott');
  assert.equal(stored.siteName, 'MusicRadar');
  assert.equal(stored.length, 11167);
  assert.ok(stored.contentHtml.includes('shooting for the stars'));
});

test('a stored success is never fetched again', async () => {
  const stored = await e.forItem(db, itemId);
  assert.equal(e.shouldFetch(stored), false);

  // Not even much later: an article does not change, and re-reading it would
  // spend a request on the publisher to replace text nobody asked to replace.
  const later = Date.parse(stored.fetchedAt) + 400 * 24 * 60 * 60 * 1000;
  assert.equal(e.shouldFetch(stored, later), false);
});

test('a failure is remembered, so the next reader does not repeat it', async () => {
  await e.save(db, {
    itemId,
    url: 'https://www.musicradar.com/artists/def-leppard-hysteria',
    status: 'blocked',
    reason: 'http-403',
  });

  const stored = await e.forItem(db, itemId);
  assert.equal(stored.status, 'blocked');
  assert.equal(stored.reason, 'http-403');
  // Saving over a success clears the body rather than leaving a stale one
  // behind a failed status.
  assert.equal(stored.contentHtml, null);
  assert.equal(stored.length, 0);

  assert.equal(e.shouldFetch(stored), false);
});

test('a failure goes stale and is tried again', async () => {
  const stored = await e.forItem(db, itemId);
  const due = Date.parse(stored.fetchedAt) + e.RETRY_AFTER_MS;

  assert.equal(e.shouldFetch(stored, due - 1000), false);
  assert.equal(e.shouldFetch(stored, due), true);
});

test('a row with an unreadable timestamp is treated as due, not as permanent', () => {
  assert.equal(e.shouldFetch({ status: 'empty', fetchedAt: 'not a date' }), true);
});

test('a 5xx is a hiccup and is retried in minutes, not tomorrow', () => {
  // The case this exists for: c0mpute.com answered 500 once in ninety-nine
  // requests, the reader's single probe landed on it, and the post lost its
  // reader page for a day. A server saying it failed is not a server refusing.
  const at = Date.parse('2026-08-18T08:54:06.232Z');
  const stored = {
    status: /** @type {const} */ ('blocked'),
    reason: 'http-500',
    fetchedAt: '2026-08-18T08:54:06.232Z',
  };

  assert.equal(e.isTransient(stored), true);
  assert.equal(e.shouldFetch(stored, at + e.TRANSIENT_RETRY_MS - 1000), false);
  assert.equal(e.shouldFetch(stored, at + e.TRANSIENT_RETRY_MS), true);
  // And emphatically sooner than the day a refusal gets.
  assert.ok(e.TRANSIENT_RETRY_MS < e.RETRY_AFTER_MS);
});

test('a network error is transient too — we never heard an answer', () => {
  const stored = { status: 'error', reason: 'fetch-failed', fetchedAt: '2026-08-18T08:54:06.232Z' };
  assert.equal(e.isTransient(stored), true);
});

test('a refusal is an answer, and keeps the full day', () => {
  const at = Date.parse('2026-08-18T08:54:06.232Z');
  for (const reason of ['http-401', 'http-403', 'http-404', 'http-451', 'blocked-host']) {
    const stored = { status: 'blocked', reason, fetchedAt: '2026-08-18T08:54:06.232Z' };
    assert.equal(e.isTransient(stored), false, reason);
    assert.equal(e.shouldFetch(stored, at + e.TRANSIENT_RETRY_MS), false, reason);
    assert.equal(e.shouldFetch(stored, at + e.RETRY_AFTER_MS), true, reason);
  }
});

test('a paywall parses to nothing today and tomorrow, so it waits the day', () => {
  const at = Date.parse('2026-08-18T08:54:06.232Z');
  const stored = { status: 'empty', reason: 'no-article', fetchedAt: '2026-08-18T08:54:06.232Z' };

  assert.equal(e.isTransient(stored), false);
  assert.equal(e.shouldFetch(stored, at + e.TRANSIENT_RETRY_MS), false);
});
