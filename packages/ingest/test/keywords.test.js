import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, discovery, q } from '@rssamplifier/db';

import { discoverFromKeywords, drainDiscoveryKeywords } from '../src/keywords.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-keywords-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A fetch stand-in for the search provider.
 *
 * Discovery's own fetches — the ones that resolve a feed — are never made here:
 * every test runs with inlineLimit 0 so the checking phase is left to the
 * poller, which keeps the suite offline and fast.
 *
 * @param {Record<string, string[]>} byKeyword
 */
function stubSearch(byKeyword) {
  const calls = [];
  const impl = async (url) => {
    const keyword = new URL(String(url)).searchParams.get('q');
    calls.push(keyword);
    const links = byKeyword[keyword] ?? [];
    return { ok: true, status: 200, json: async () => ({ organic_results: links.map((l) => ({ link: l })) }) };
  };
  impl.calls = calls;
  return impl;
}

test('a run queues its keywords and the sites they find', async () => {
  const fetchImpl = stubSearch({
    'siberian huskies': ['https://huskyblog.example/post/1', 'https://huskyblog.example/post/2'],
    'malamute care': ['https://mals.example/care', 'https://www.reddit.com/r/malamute'],
  });

  const res = await discoverFromKeywords(db, ['siberian huskies', 'malamute care'], {
    inlineLimit: 0,
    searchOpts: { apiKey: 'k', fetchImpl },
  });

  assert.equal(res.searched, 2);
  // Two hosts: the two article URLs collapse to one site, and reddit is dropped.
  assert.equal(res.candidates, 2);
  assert.equal(res.queuedCandidates, 2);
  assert.equal(res.queuedKeywords, 0);

  const run = await discovery.runById(db, res.runId);
  assert.equal(String(run.status), 'queued');
  assert.deepEqual(JSON.parse(String(run.keywords)), ['siberian huskies', 'malamute care']);
});

test('the search budget stops the inline phase and leaves the rest queued', async () => {
  const fetchImpl = stubSearch({ one: ['https://one.example/'], two: ['https://two.example/'] });

  // A clock that jumps past the budget after the first search.
  let calls = 0;
  const now = () => (calls++ === 0 ? 0 : 1_000_000);

  const res = await discoverFromKeywords(db, ['one', 'two'], {
    inlineLimit: 0,
    now,
    searchOpts: { apiKey: 'k', fetchImpl },
  });

  assert.equal(res.searched, 0, 'the deadline is checked before the first search');
  assert.equal(res.queuedKeywords, 2);

  const run = await discovery.runById(db, res.runId);
  assert.equal(String(run.status), 'queued');
});

test('an exhausted quota fails the run without pretending it found nothing', async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, json: async () => ({}) });

  const res = await discoverFromKeywords(db, ['dry'], {
    inlineLimit: 0,
    searchOpts: { apiKey: 'k', fetchImpl },
  });

  assert.equal(res.error, 'quota-exhausted');
  const run = await discovery.runById(db, res.runId);
  assert.equal(String(run.status), 'failed');
  assert.equal(String(run.error), 'quota-exhausted');

  // The keyword stays queued: credits reset monthly, and the poller should pick
  // this up then rather than the run being permanently half-done.
  const progress = await discovery.keywordProgress(db, res.runId);
  assert.equal(progress.waiting, 1);
});

test('the poller searches what the request could not', async () => {
  const fetchImpl = stubSearch({ later: ['https://later.example/a'] });

  const started = await discoverFromKeywords(db, ['later'], {
    inlineLimit: 0,
    searchBudgetMs: -1, // nothing fits inline
    searchOpts: { apiKey: 'k', fetchImpl },
  });
  assert.equal(started.queuedKeywords, 1);

  // The queue is global and earlier tests left keywords in it, so the drain is
  // asserted on this run rather than on its own totals.
  const drained = await drainDiscoveryKeywords(db, 20, { searchOpts: { apiKey: 'k', fetchImpl } });
  assert.ok(drained.searched >= 1);
  assert.equal(drained.queued, 1, 'the one site this run found');

  const progress = await discovery.keywordProgress(db, started.runId);
  assert.equal(progress.waiting, 0);
  assert.equal(progress.searched, 1);

  const run = await discovery.runById(db, started.runId);
  assert.equal(String(run.status), 'queued', 'its site is still waiting to be checked');
});

test('hosts already in the directory are never queued again', async () => {
  await q.insertFeed(db, {
    slug: 'known-blog',
    feed_url: 'https://known.example/feed.xml',
    site_url: 'https://known.example/',
    title: 'Known Blog',
  });

  const fetchImpl = stubSearch({
    known: ['https://known.example/post', 'https://fresh.example/post'],
  });

  const res = await discoverFromKeywords(db, ['known'], {
    inlineLimit: 0,
    searchOpts: { apiKey: 'k', fetchImpl },
  });

  const rows = await discovery.queuedCandidates(db, 100);
  const hosts = rows.filter((r) => String(r.run_id) === res.runId).map((r) => String(r.host));

  assert.deepEqual(hosts, ['fresh.example']);
});

test('the same site under two keywords is one candidate', async () => {
  const fetchImpl = stubSearch({
    'dogs a': ['https://twice.example/1'],
    'dogs b': ['https://twice.example/2'],
  });

  const res = await discoverFromKeywords(db, ['dogs a', 'dogs b'], {
    inlineLimit: 0,
    searchOpts: { apiKey: 'k', fetchImpl },
  });

  const rows = await discovery.queuedCandidates(db, 500);
  const mine = rows.filter((r) => String(r.run_id) === res.runId && String(r.host) === 'twice.example');

  assert.equal(mine.length, 1);
});

test('discovery never writes to feeds before a candidate is checked', async () => {
  const before = await q.countFeeds(db, true);

  const fetchImpl = stubSearch({ 'no writes': ['https://unchecked.example/a'] });
  await discoverFromKeywords(db, ['no writes'], {
    inlineLimit: 0,
    searchOpts: { apiKey: 'k', fetchImpl },
  });

  // The whole reason candidates are a separate table: an unvetted search result
  // must not become a public page at /<slug>.
  assert.equal(await q.countFeeds(db, true), before);
});
