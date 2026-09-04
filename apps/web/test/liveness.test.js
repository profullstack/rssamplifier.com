import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withLiveness } from '../src/lib/crawlstats.js';

const NOW = Date.parse('2026-09-04T09:33:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

test('a fresh clock replaces the cached one', () => {
  // The bug this exists for: the snapshot was primed at :02 and it is :33, so
  // the cached timestamp says 31 minutes idle -- while the crawler landed a
  // read moments ago. The badge must read the crawler, not the cache.
  const got = withLiveness({ lastSuccessAt: at(31), due: 95_916 }, at(0.2), NOW);
  assert.equal(got.lastSuccessAt, at(0.2));
  assert.equal(got.idleMinutes, 0);
  assert.equal(got.due, 95_916, 'the counts are untouched');
});

test('a stalled crawler still reads as stalled', () => {
  // The direction the caching was originally checked in, and it must still
  // hold: nothing newer than the cached timestamp means the gap keeps growing.
  const got = withLiveness({ lastSuccessAt: at(31) }, at(31), NOW);
  assert.equal(got.idleMinutes, 31);
});

test('a failed re-read leaves the cached clock in place', () => {
  // `panel` hands back null when the seek does not answer in time. The page
  // still renders, off the cached timestamp -- older than the truth, never
  // newer, which is the only safe way for this number to be wrong.
  const got = withLiveness({ lastSuccessAt: at(12) }, null, NOW);
  assert.equal(got.lastSuccessAt, at(12));
  assert.equal(got.idleMinutes, 12);
});

test('the clock never runs backwards', () => {
  // A fresh read older than the cached one is a replica behind the primary,
  // not a success being retracted. Taking it would un-alarm a page that was
  // right a second ago.
  const got = withLiveness({ lastSuccessAt: at(2) }, at(40), NOW);
  assert.equal(got.lastSuccessAt, at(2));
  assert.equal(got.idleMinutes, 2);
});

test('a directory with no success yet has no clock', () => {
  const got = withLiveness({ lastSuccessAt: null }, null, NOW);
  assert.equal(got.lastSuccessAt, null);
  assert.equal(got.idleMinutes, null, 'null, which the page treats as stopped');
});

test('a first success arrives while the snapshot still says none', () => {
  const got = withLiveness({ lastSuccessAt: null }, at(1), NOW);
  assert.equal(got.idleMinutes, 1);
});
