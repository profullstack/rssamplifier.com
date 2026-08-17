import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupByHost, spreadHosts, PER_HOST_DEFAULT } from '../src/crawl.js';

/**
 * Spreading a batch across hosts.
 *
 * The measured problem this fixes: a host's feeds are crawled strictly in
 * series — that is the politeness guarantee — so a batch that is half one
 * domain takes as long as that half however many workers are pointed at it. In
 * a 500-feed sample of the live directory, 164 feeds sat on one host and 76 on
 * another, so a 300-feed batch handed one worker a hundred feeds while the rest
 * finished single-feed queues in seconds and went home.
 */

/**
 * @param {string} host
 * @param {number} n
 * @returns {Array<{ feed_url: string }>}
 */
function onHost(host, n) {
  return Array.from({ length: n }, (_, i) => ({ feed_url: `https://${host}/feed/${i}.xml` }));
}

test('a batch is spread across hosts rather than let one host own it', () => {
  const pool = [...onHost('big.example', 100)];
  for (let i = 0; i < 40; i += 1) pool.push(...onHost(`h${i}.example`, 1));

  const batch = spreadHosts(pool, 40, 8);

  assert.equal(batch.length, 40, 'the batch is still full');
  const fromBig = batch.filter((f) => f.feed_url.includes('big.example')).length;
  assert.equal(fromBig, 8, 'the crowded host is held to its share');
  assert.equal(groupByHost(batch).length, 33, 'so the workers have many queues to take');
});

test('the cap never under-fills a batch that could be full', () => {
  // The case that would have made this change a regression rather than a fix:
  // everything due is one host, which is exactly what a bulk import coming due
  // together looks like. Throttling to `perHost` there would crawl 8 feeds a
  // tick where the old code crawled 50.
  const pool = onHost('only.example', 300);

  assert.equal(spreadHosts(pool, 50, 8).length, 50, 'the cap lifts rather than starving the batch');
});

test('a partly crowded pool fills from the held-back rows in due order', () => {
  // Two hosts, one over its cap, and not enough other work to fill the batch.
  const pool = [...onHost('big.example', 10), ...onHost('small.example', 1)];
  const batch = spreadHosts(pool, 8, 3);

  assert.equal(batch.length, 8);
  assert.equal(batch.filter((f) => f.feed_url.includes('small.example')).length, 1);
  // The first three big.example feeds come from the capped pass, the rest from
  // the fill — and all of them keep the order they came due in.
  const big = batch.filter((f) => f.feed_url.includes('big.example')).map((f) => f.feed_url);
  assert.deepEqual(big, onHost('big.example', 7).map((f) => f.feed_url));
});

test('spreading keeps due order within a host', () => {
  const pool = onHost('one.example', 5);

  assert.deepEqual(
    spreadHosts(pool, 3, 8).map((f) => f.feed_url),
    pool.slice(0, 3).map((f) => f.feed_url),
    'the feeds waiting longest are still the ones taken',
  );
});

test('a pool smaller than the batch is taken whole', () => {
  const pool = [...onHost('a.example', 2), ...onHost('b.example', 2)];

  assert.equal(spreadHosts(pool, 100, 8).length, 4);
  assert.deepEqual(spreadHosts([], 100, 8), []);
  assert.deepEqual(spreadHosts(pool, 0, 8), [], 'and a zero batch asks for nothing');
});

test('the default cap is a number a single host can actually absorb', () => {
  // A crawl of a live feed averages ~9s against a network database, so much
  // more than a handful per 60-second tick is a queue the host cannot drain
  // anyway — the cap costs a well-behaved host nothing.
  assert.ok(PER_HOST_DEFAULT >= 4 && PER_HOST_DEFAULT <= 16);
});

test('unparseable URLs are spread rather than collapsed into one host', () => {
  // They share no hostname, so they must not land in one bucket and serialise
  // behind each other for no reason.
  const pool = [{ feed_url: 'not a url' }, { feed_url: 'also not a url' }];

  assert.equal(groupByHost(pool).length, 2);
  assert.equal(spreadHosts(pool, 10, 1).length, 2);
});
