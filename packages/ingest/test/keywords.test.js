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

test('onStarted fires with the run readable and before any searching', async () => {
  const fetchImpl = stubSearch({ kites: ['https://kites.example/'] });

  /** @type {string|null} */
  let seenRunId = null;
  let searchesWhenStarted = -1;
  /** @type {object|null} */
  let rowWhenStarted = null;
  let keywordsWhenStarted = -1;

  await discoverFromKeywords(db, ['kites'], {
    inlineLimit: 0,
    searchOpts: { apiKey: 'k', fetchImpl },
    onStarted: (runId) => {
      seenRunId = runId;
      searchesWhenStarted = fetchImpl.calls.length;
    },
  });

  assert.ok(seenRunId, 'the callback is handed the id the status page lives at');
  assert.equal(
    searchesWhenStarted,
    0,
    'and fires before the first search — that is what the web route stops waiting for',
  );

  // The point of the signal is that the status page works from that moment on,
  // so the row and its keywords must already be readable, not merely promised.
  rowWhenStarted = await discovery.runById(db, seenRunId);
  assert.ok(rowWhenStarted, 'the run row exists');
  assert.deepEqual(JSON.parse(String(rowWhenStarted.keywords)), ['kites']);

  const progress = await discovery.keywordProgress(db, seenRunId);
  keywordsWhenStarted = progress.total;
  assert.equal(keywordsWhenStarted, 1, 'and its keywords are queued');
});

test('a run without an onStarted callback behaves exactly as before', async () => {
  const fetchImpl = stubSearch({ hats: ['https://hats.example/'] });

  const res = await discoverFromKeywords(db, ['hats'], {
    inlineLimit: 0,
    searchOpts: { apiKey: 'k', fetchImpl },
  });

  assert.equal(res.searched, 1);
  assert.equal(res.queuedCandidates, 1);
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

test('a poller tick stops starting keywords once its budget is spent', async () => {
  // A keyword is a dozen requests now, so an unbounded batch is a tick that
  // runs for ten minutes and starves the crawl that shares it.
  const fetchImpl = stubSearch({
    'budget one': ['https://budget-one.example/a'],
    'budget two': ['https://budget-two.example/a'],
  });

  await discoverFromKeywords(db, ['budget one', 'budget two'], {
    inlineLimit: 0,
    searchBudgetMs: -1, // both queue
    searchOpts: { apiKey: 'k', fetchImpl },
  });

  const drained = await drainDiscoveryKeywords(db, 20, {
    budgetMs: -1, // already spent before the first keyword
    searchOpts: { apiKey: 'k', fetchImpl },
  });

  assert.equal(drained.searched, 0, 'nothing started');
  assert.equal(drained.failed, 0, 'and nothing marked failed for it');
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

test('a run only checks its own candidates, and reports its own counts', async () => {
  // An older run leaves a candidate sitting in the queue.
  const stale = await discoverFromKeywords(db, ['stale subject'], {
    inlineLimit: 0,
    searchOpts: { apiKey: 'k', fetchImpl: stubSearch({ 'stale subject': ['https://stale.example/a'] }) },
  });
  assert.equal(stale.queuedCandidates, 1);

  // A new run checks with a real budget. Its own candidate cannot resolve a
  // feed offline, so it is recorded errored — but the stale one must be
  // untouched, and the counts must describe this run rather than the loop.
  const res = await discoverFromKeywords(db, ['fresh subject'], {
    inlineLimit: 100,
    searchOpts: { apiKey: 'k', fetchImpl: stubSearch({ 'fresh subject': ['https://mine.example/a'] }) },
  });

  const queued = await discovery.queuedCandidates(db, 500);
  const stillQueued = queued.filter((r) => String(r.run_id) === stale.runId).map((r) => String(r.host));
  assert.deepEqual(stillQueued, ['stale.example'], 'the older run was drained by someone else’s request');

  const progress = await discovery.runProgress(db, res.runId);
  assert.equal(res.candidates, progress.total);
  assert.equal(res.accepted, progress.accepted);
  assert.equal(res.rejected, progress.rejected + progress.errored);
});

test('a discovered feed keeps the category the parser gave it', async () => {
  // The bug: checkCandidate built its insertFeed call without `kind`, and
  // insertFeed defaults an absent kind to 'blog'. Every discovered feed was
  // therefore a blog — a PeerTube instance whose every item carries a
  // video/mp4 enclosure included. Curated sources masked it by overwriting the
  // category straight afterwards.
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { connect, migrate, q, discovery } = await import('@rssamplifier/db');

  const dir = await mkdtemp(join(tmpdir(), 'rssamp-kind-'));
  const db = connect({ url: `file:${join(dir, 'k.db')}` });
  await migrate(db);

  const runId = await discovery.insertRun(db, { provider: 'peertube', keywords: [] });
  await discovery.insertCandidates(db, runId, [
    { url: 'https://tube.example/feeds/videos.xml', host: 'tube.example/feeds/videos.xml' },
  ]);
  const [candidate] = await discovery.queuedCandidates(db, 1);

  // A video feed in the shape PeerTube serves: real items, recent dates, and
  // a video/mp4 enclosure on every one. Realistic enough to pass worthiness,
  // because an uncurated run checks it — which is the path the bug was on.
  const feedXml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Tube Example</title><link>https://tube.example/</link>
  <description>Federated video from a small instance</description>
    <item>
      <title>Episode 1</title>
      <link>https://tube.example/w/1</link>
      <guid>https://tube.example/w/1</guid>
      <description>A recorded talk about federated video, part 1.</description>
      <pubDate>Thu, 13 Aug 2026 19:45:17 GMT</pubDate>
      <enclosure length="3814946" type="video/mp4" url="https://tube.example/download/1.mp4"/>
    </item>
    <item>
      <title>Episode 2</title>
      <link>https://tube.example/w/2</link>
      <guid>https://tube.example/w/2</guid>
      <description>A recorded talk about federated video, part 2.</description>
      <pubDate>Mon, 10 Aug 2026 19:45:17 GMT</pubDate>
      <enclosure length="3814946" type="video/mp4" url="https://tube.example/download/2.mp4"/>
    </item>
    <item>
      <title>Episode 3</title>
      <link>https://tube.example/w/3</link>
      <guid>https://tube.example/w/3</guid>
      <description>A recorded talk about federated video, part 3.</description>
      <pubDate>Fri, 07 Aug 2026 19:45:17 GMT</pubDate>
      <enclosure length="3814946" type="video/mp4" url="https://tube.example/download/3.mp4"/>
    </item>
    <item>
      <title>Episode 4</title>
      <link>https://tube.example/w/4</link>
      <guid>https://tube.example/w/4</guid>
      <description>A recorded talk about federated video, part 4.</description>
      <pubDate>Tue, 04 Aug 2026 19:45:17 GMT</pubDate>
      <enclosure length="3814946" type="video/mp4" url="https://tube.example/download/4.mp4"/>
    </item>
    <item>
      <title>Episode 5</title>
      <link>https://tube.example/w/5</link>
      <guid>https://tube.example/w/5</guid>
      <description>A recorded talk about federated video, part 5.</description>
      <pubDate>Sat, 01 Aug 2026 19:45:17 GMT</pubDate>
      <enclosure length="3814946" type="video/mp4" url="https://tube.example/download/5.mp4"/>
    </item>
</channel></rss>`;

  const { checkCandidate } = await import('../src/keywords.js');
  const { parseFeed } = await import('@rssamplifier/feed');

  const result = await checkCandidate(db, candidate, {
    // Resolved without a network round trip; the parsing under test is real.
    resolveImpl: async () => ({
      ok: true,
      feedUrl: 'https://tube.example/feeds/videos.xml',
      feed: parseFeed(feedXml),
    }),
  });

  assert.equal(result.status, 'accepted');
  const stored = await q.feedBySlug(db, result.slug);
  assert.equal(String(stored.category), 'video', 'stored as what it is, not as a blog');

  await rm(dir, { recursive: true, force: true });
});
