import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q } from '@rssamplifier/db';

import { enrichDue } from '../src/enrich.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-enrich-pool-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * @param {string} slug
 * @param {string} host
 */
async function seed(slug, host) {
  await q.insertFeed(db, {
    slug,
    feed_url: `https://${host}/${slug}.xml`,
    site_url: `https://${host}/`,
    title: slug,
    categories: [],
    kind: 'blog',
    status: 'active',
  });
}

/**
 * A fetcher that records when each request to a host is in flight, so a test
 * can assert on overlap rather than on timing.
 *
 * @param {number} delayMs
 */
function tracking(delayMs) {
  const inFlight = new Map();
  const overlapped = new Set();
  let peak = 0;
  let live = 0;

  const fetcher = async (url) => {
    const host = new URL(url).hostname;
    const now = (inFlight.get(host) ?? 0) + 1;
    inFlight.set(host, now);
    if (now > 1) overlapped.add(host);

    live += 1;
    peak = Math.max(peak, live);

    await new Promise((r) => setTimeout(r, delayMs));

    inFlight.set(host, inFlight.get(host) - 1);
    live -= 1;
    return { ok: false, status: 404, contentType: '', body: '', url };
  };

  fetcher.overlapped = overlapped;
  fetcher.peak = () => peak;
  return fetcher;
}

const resolve = async () => ({ ok: true, feed: { title: 'x', siteUrl: '', credits: [], items: [] } });

test('unrelated publishers are enriched at the same time', async () => {
  // The whole point of the change: eight distinct blogs used to be walked one
  // after another, so the pass took the sum of their slowest pages rather than
  // the longest of them.
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) await seed(`pool-${i}`, `pool${i}.example`);

  const fetcher = tracking(60);
  const result = await enrichDue(db, 8, { fetch: fetcher, resolve, concurrency: 4 });

  assert.equal(result.feeds, 8);
  assert.ok(fetcher.peak() > 1, `expected concurrent fetches, saw a peak of ${fetcher.peak()}`);
  assert.ok(fetcher.peak() <= 4, `concurrency was not respected: peak ${fetcher.peak()}`);
});

test('one publisher is never asked for two pages at once', async () => {
  // The politeness guarantee the serial pass provided, which this had to keep:
  // a directory that asks people to publish rel="me" must not be the reason
  // their server falls over. Same host, many feeds, still strictly in series.
  for (const i of [1, 2, 3, 4, 5, 6]) await seed(`same-${i}`, 'oneblog.example');

  const fetcher = tracking(40);
  await enrichDue(db, 6, { fetch: fetcher, resolve, concurrency: 6 });

  assert.deepEqual(
    [...fetcher.overlapped],
    [],
    'a host was asked for two pages at once, which the serial pass never did',
  );
});

test('a batch that is entirely one host is still walked, not throttled away', async () => {
  // A bulk import comes due together and is legitimately one host. The
  // per-host cap must not turn that into three feeds a tick forever.
  for (const i of [1, 2, 3, 4, 5, 6, 7]) await seed(`bulk-${i}`, 'bulk.example');

  const result = await enrichDue(db, 7, { fetch: tracking(1), resolve, concurrency: 4 });

  assert.equal(result.feeds, 7, 'the whole batch should be taken when there is nothing to spread');
  assert.equal(result.hosts, 1);
});

test('nothing due is not an error and does no work', async () => {
  const result = await enrichDue(db, 5, {
    fetch: () => assert.fail('nothing was due; no page should have been asked for'),
    resolve,
    recheckDays: 3650,
  });

  assert.equal(result.feeds, 0);
  assert.equal(result.hosts, 0);
});
