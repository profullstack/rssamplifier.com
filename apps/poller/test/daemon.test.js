import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memoryStore } from '@profullstack/scraper-daemon';

import { BOOT_JOBS, buildPollerDaemon, onGrid, primeBootJobs } from '../src/daemon.js';

/**
 * The poller's schedule, built with stub jobs and no database.
 *
 * index.js connects and starts at import, so it cannot be loaded here; the
 * schedule was moved into src/daemon.js precisely so the part that decides what
 * runs (and what catch-up mode leaves out) can be asserted on directly.
 */

const RUN_KEYS = [
  'crawl', 'import', 'purge',
  'discoveryKeywords', 'discoveryQueue', 'discoverySources', 'discoveryTopics', 'discoveryNotify', 'topics',
  'clusterBackfill', 'cards', 'alerts', 'newsletter', 'authors', 'rings', 'queueSample', 'statsWarm', 'authorSearch', 'writeTally',
];

function stubs(calls = []) {
  return Object.fromEntries(RUN_KEYS.map((k) => [k, async () => { calls.push(k); }]));
}

function config(over = {}) {
  return {
    intervalMs: 60_000,
    catchupOnly: false,
    clusterBackfill: true, clusterIntervalMs: 10_000,
    cardEnabled: true, cardIntervalMs: 20_000,
    alertIntervalMs: 120_000,
    authorEnabled: true, authorIntervalMs: 60_000,
    ringEnabled: true, ringIntervalMs: 60_000,
    queueSampleMs: 600_000,
    statsWarmMs: 300_000,
    searchEnabled: true, searchIntervalMs: 900_000,
    tally: true,
    sourceIntervalMs: 1_800_000,
    topicSearchIntervalMs: 86_400_000,
    topicsIntervalMs: 900_000,
    ...over,
  };
}

async function jobsOf(daemon) {
  const status = await daemon.status();
  return Object.fromEntries(status.tasks.map((t) => [t.name, t.every]));
}

const silent = () => {};

test('every timer the poller had is a job, at its old cadence', async () => {
  const daemon = buildPollerDaemon({ store: memoryStore(), log: silent, config: config(), run: stubs() });
  assert.deepEqual(await jobsOf(daemon), {
    crawl: 60_000,
    import: 60_000,
    purge: 3_600_000,
    'discovery-keywords': 60_000,
    'discovery-queue': 60_000,
    'discovery-sources': 1_800_000,
    'discovery-topics': 86_400_000,
    'discovery-notify': 60_000,
    topics: 900_000,
    'cluster-backfill': 10_000,
    cards: 20_000,
    alerts: 120_000,
    newsletter: 600_000,
    authors: 60_000,
    rings: 60_000,
    'queue-sample': 600_000,
    'stats-warm': 300_000,
    'author-search': 900_000,
    'write-tally': 600_000,
    'daemon-status': 60_000,
  });
});

test('catch-up mode registers only what the old tick ran above its early return', async () => {
  const daemon = buildPollerDaemon({
    store: memoryStore(),
    log: silent,
    // Production's settings: catch-up on, the auxiliary passes switched off.
    config: config({ catchupOnly: true, clusterBackfill: false, cardEnabled: false, authorEnabled: false, searchEnabled: false }),
    run: stubs(),
  });
  const names = Object.keys(await jobsOf(daemon));
  assert.deepEqual(names, ['crawl', 'import', 'purge', 'alerts', 'newsletter', 'rings', 'queue-sample', 'stats-warm', 'write-tally', 'daemon-status']);
  // The upload queue a person is watching survives catch-up mode (the bug of
  // 2026-08-19); discovery, which nobody is waiting on, does not.
  assert.ok(names.includes('import'));
  assert.ok(!names.some((n) => n.startsWith('discovery-')));
  assert.ok(!names.includes('topics'));
});

test('a job runs the function it was handed, and the crawl failing is a failed job', async () => {
  const calls = [];
  const run = stubs(calls);
  run.crawl = async () => { calls.push('crawl'); throw new Error('db down'); };
  const daemon = buildPollerDaemon({ store: memoryStore(), log: silent, config: config(), run });

  const imported = await daemon.runNow('import');
  assert.equal(imported.ok, true);
  const crawled = await daemon.runNow('crawl');
  assert.equal(crawled.ok, false);
  assert.deepEqual(calls, ['import', 'crawl']);

  const crawl = (await daemon.status()).tasks.find((t) => t.name === 'crawl');
  assert.equal(crawl.fails, 1);
  assert.match(crawl.lastError, /db down/);
  // Retried at its own cadence, not the default ladder's five minutes and up.
  assert.ok(crawl.nextAt - Date.now() <= 60_000);
});

test('the status job writes the status document where the web service reads it', async () => {
  const store = memoryStore();
  const daemon = buildPollerDaemon({ store, log: silent, config: config(), run: stubs() });
  await daemon.runNow('daemon-status');
  const status = await store.get('status');
  assert.equal(status.name, 'rssamplifier.com');
  assert.ok(status.tasks.some((t) => t.name === 'crawl'));
  assert.ok(status.writtenAt > 0);
});

test('a missing function is refused at build time, not at 3am', () => {
  const run = stubs();
  delete run.rings;
  assert.throws(() => buildPollerDaemon({ store: memoryStore(), log: silent, config: config(), run }), /rings/);
});

test('cadence follows the setInterval grid', () => {
  assert.equal(onGrid(60_000, 0), 60_000);
  assert.equal(onGrid(60_000, 50_000), 10_000);
  // A run that overran its slot waits for the next one, as a skipped tick did.
  assert.equal(onGrid(60_000, 61_000), 59_000);
});

test('boot jobs are made due at boot without losing their history', async () => {
  const store = memoryStore();
  const later = Date.now() + 3_600_000;
  await store.save('stats-warm', { key: '*', lastTry: 1, lastOk: 1, nextAt: later, fails: 0, lastError: null });
  await store.save('discovery-topics', { key: '*', lastTry: 1, lastOk: 1, nextAt: later, fails: 0, lastError: null });
  await primeBootJobs(store);
  assert.ok(BOOT_JOBS.includes('stats-warm'));
  assert.equal((await store.load('stats-warm')).get('*').nextAt, 0);
  assert.equal((await store.load('stats-warm')).get('*').lastOk, 1);
  // The daily search keeps its schedule across a deploy.
  assert.equal((await store.load('discovery-topics')).get('*').nextAt, later);
});
