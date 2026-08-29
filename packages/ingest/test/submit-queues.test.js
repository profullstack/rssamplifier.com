import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q } from '@rssamplifier/db';

import { submitCatalogue, submitOne } from '../src/submit.js';

let dir;
let db;

/**
 * The real `fetch`, put back after each test.
 *
 * These tests are about what submitting does *not* do, so the assertion is on
 * the network rather than on the database: a stub that throws is the only way
 * to state "and it never went to look".
 */
const realFetch = globalThis.fetch;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-submit-queues-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

test('a pasted list is queued without a single feed being fetched', async () => {
  globalThis.fetch = () => {
    throw new Error('a list must not be resolved while the submitter waits');
  };

  const entries = Array.from({ length: 8 }, (_, i) => ({
    url: `https://pasted-${i}.example/feed.xml`,
    title: `Pasted ${i}`,
  }));

  // No inlineLimit given, which is the whole point: the default has to be the
  // safe one. Eight of these took 65 seconds in production when the default
  // resolved the first hundred entries inline.
  const res = await submitCatalogue(db, entries, { submissionId: 'sub-list' });

  assert.equal(res.queued, 8);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.total, 8);

  globalThis.fetch = realFetch;
});

test('a submission small enough to have been typed goes into the express lane', async () => {
  globalThis.fetch = () => {
    throw new Error('still no fetching');
  };

  await submitCatalogue(
    db,
    Array.from({ length: 3 }, (_, i) => ({ url: `https://typed-${i}.example/feed.xml` })),
    { submissionId: 'sub-typed', priority: 1 },
  );

  const express = await q.expressFeeds(db, 100);
  const slugs = new Set(express.map((r) => String(r.slug)));

  assert.equal(express.length, 3);
  assert.ok([...slugs].every((s) => s.startsWith('typed-')));

  globalThis.fetch = realFetch;
});

test('a catalogue is queued at priority zero unless the caller says otherwise', async () => {
  globalThis.fetch = () => {
    throw new Error('still no fetching');
  };

  await submitCatalogue(
    db,
    Array.from({ length: 3 }, (_, i) => ({ url: `https://bulk-${i}.example/feed.xml` })),
    { submissionId: 'sub-bulk' },
  );

  const express = await q.expressFeeds(db, 100);
  assert.ok(
    express.every((r) => !String(r.slug).startsWith('bulk-')),
    'an upload is not expedited by default',
  );

  globalThis.fetch = realFetch;
});

test('a feed the directory already holds is answered without going to the network', async () => {
  await q.insertFeed(db, {
    slug: 'known-blog',
    feed_url: 'https://known.example/feed.xml',
    site_url: 'https://known.example/',
    title: 'Known Blog',
  });

  globalThis.fetch = () => {
    throw new Error('a feed we already have must not be re-resolved');
  };

  const res = await submitOne(db, 'https://known.example/feed.xml');

  assert.deepEqual(res, { ok: true, slug: 'known-blog', existing: true });

  globalThis.fetch = realFetch;
});

test('the short-circuit normalises first, so a scruffy paste still matches', async () => {
  globalThis.fetch = () => {
    throw new Error('still a feed we already have');
  };

  // What people actually paste: no scheme, a stray fragment, surrounding space.
  const res = await submitOne(db, '  known.example/feed.xml#top  ');

  assert.equal(res.ok, true);
  assert.equal(res.slug, 'known-blog');

  globalThis.fetch = realFetch;
});

test('a single URL is still resolved inline, because it has a blog to land on', async () => {
  // The one case that keeps its fetch, and the assertion is the opposite of
  // every test above: this one has to prove a resolve was *attempted*.
  //
  // It is proved by the attempt failing rather than by a stubbed response.
  // `safeFetch` resolves the hostname itself before it fetches anything — the
  // SSRF guard — and `.example` has no DNS, so the resolve stops at
  // `blocked-host` without `fetch` ever being reached. A stub cannot observe
  // this; a rejection can, and a rejection is only possible if the entry went
  // to the head rather than the tail.
  const res = await submitCatalogue(db, [{ url: 'https://solo.example/feed.xml' }], {
    submissionId: 'sub-solo',
  });

  assert.equal(res.queued, 0, 'one URL is not queued, it is resolved');
  assert.equal(res.accepted.length, 0);
  assert.deepEqual(res.rejected, [
    { url: 'https://solo.example/feed.xml', error: 'blocked-host' },
  ]);
});
