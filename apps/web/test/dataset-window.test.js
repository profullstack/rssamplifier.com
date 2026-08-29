import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  windowStart,
  windowEnd,
  latestClosedWindow,
  resolveWindow,
  startOfUtcDay,
} from '../src/lib/datasetWindow.js';

/**
 * The clock the corpus is sold by.
 *
 * Worth testing out of proportion to its size. Every other failure in this
 * feature is loud — a broken stream 500s, a missing licence 402s — but an
 * off-by-one here is silent on both sides: the buyer's pipeline walks
 * boundaries, receives a slice that quietly omits an hour, and neither we nor
 * they find out until somebody audits a corpus months later. So the cases below
 * are about the seams: the boundary itself, the moment either side of it, and
 * every way a caller can name one that does not exist.
 */

/** 2026-08-29T14:23:11Z — mid-window, on purpose. */
const MID = Date.parse('2026-08-29T14:23:11.000Z');

test('a moment floors to the window containing it', () => {
  assert.equal(windowStart(MID), '2026-08-29T12:00:00.000Z');
});

test('the boundary itself belongs to the window it opens, not the one it closes', () => {
  // The half-open range is the whole contract: [12:00, 16:00) means a row
  // stamped exactly 12:00 is in this window and not in the previous one. Get
  // this wrong in either direction and every boundary row is either duplicated
  // across two slices or in neither.
  const boundary = Date.parse('2026-08-29T12:00:00.000Z');
  assert.equal(windowStart(boundary), '2026-08-29T12:00:00.000Z');
  assert.equal(windowStart(boundary - 1), '2026-08-29T08:00:00.000Z');
});

test('windows tile the day without gap or overlap', () => {
  const seen = [];
  let at = windowStart(Date.parse('2026-08-29T00:00:00.000Z'));
  for (let i = 0; i < 6; i += 1) {
    seen.push(at);
    const end = windowEnd(at);
    // The next window starts exactly where this one ended. Anything else is a
    // gap or an overlap, and both are corpus bugs.
    assert.equal(windowStart(Date.parse(end)), end);
    at = end;
  }

  assert.deepEqual(seen, [
    '2026-08-29T00:00:00.000Z',
    '2026-08-29T04:00:00.000Z',
    '2026-08-29T08:00:00.000Z',
    '2026-08-29T12:00:00.000Z',
    '2026-08-29T16:00:00.000Z',
    '2026-08-29T20:00:00.000Z',
  ]);
  // Six four-hour windows land back on midnight: the tiling closes the day.
  assert.equal(at, '2026-08-30T00:00:00.000Z');
});

test('the newest window on offer is the one before the one still filling', () => {
  assert.equal(latestClosedWindow(MID), '2026-08-29T08:00:00.000Z');
});

test('no window means the newest closed one', () => {
  const got = resolveWindow(null, MID);
  assert.equal(got.ok, true);
  assert.equal(got.start, '2026-08-29T08:00:00.000Z');
  assert.equal(got.end, '2026-08-29T12:00:00.000Z');
});

test('an aligned past window is served as asked', () => {
  const got = resolveWindow('2026-08-29T04:00:00.000Z', MID);
  assert.equal(got.ok, true);
  assert.equal(got.start, '2026-08-29T04:00:00.000Z');
  assert.equal(got.end, '2026-08-29T08:00:00.000Z');
});

test('an unaligned window is refused rather than rounded', () => {
  // Rounding here would be the worst possible kindness: the caller labels the
  // slice with the boundary they asked for, we send them a different one, and
  // their corpus is mislabelled in a way that only shows up much later as
  // duplicated rows. Naming the aligned boundary in the refusal is what makes
  // it fixable on the first run.
  const got = resolveWindow('2026-08-29T05:30:00.000Z', MID);
  assert.equal(got.ok, false);
  assert.equal(got.error, 'unaligned-window');
  assert.match(got.detail, /2026-08-29T04:00:00\.000Z/);
});

test('the window containing now has not closed and is refused', () => {
  const got = resolveWindow('2026-08-29T12:00:00.000Z', MID);
  assert.equal(got.ok, false);
  assert.equal(got.error, 'window-not-closed');
  assert.match(got.detail, /2026-08-29T08:00:00\.000Z/);
});

test('a future window is refused by the same rule', () => {
  const got = resolveWindow('2027-01-01T00:00:00.000Z', MID);
  assert.equal(got.ok, false);
  assert.equal(got.error, 'window-not-closed');
});

test('a window that is not a timestamp is refused', () => {
  const got = resolveWindow('last tuesday', MID);
  assert.equal(got.ok, false);
  assert.equal(got.error, 'bad-window');
});

test('the UTC day starts at midnight UTC wherever the server thinks it is', () => {
  // The full-dump allowance is a per-UTC-day count, and a server in a westward
  // timezone using local midnight would hand out a second full dump hours early
  // — the most expensive query in this feature, doubled, invisibly.
  assert.equal(startOfUtcDay(MID), '2026-08-29T00:00:00.000Z');
  assert.equal(startOfUtcDay(Date.parse('2026-08-29T00:00:00.000Z')), '2026-08-29T00:00:00.000Z');
  assert.equal(startOfUtcDay(Date.parse('2026-08-29T23:59:59.999Z')), '2026-08-29T00:00:00.000Z');
});
