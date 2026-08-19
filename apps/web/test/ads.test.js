import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adPositions } from '@rssamplifier/feed';

import { AD_MREC, AD_TEXT, adPlan } from '../src/lib/ads.js';
import { feedAdPlan } from '../src/lib/feedAdPlan.js';

test('a short list carries no advertising at all', () => {
  // Four rows and a slot after the third leaves one row underneath it, which is
  // not an in-feed ad — it is a footer ad with a row stuck to the bottom.
  assert.equal(adPlan(4, { first: 3, every: 12 }).size, 0);
  assert.equal(adPlan(0, { first: 3, every: 12 }).size, 0);
});

test('the first unit lands where it was asked for, and the rest follow the gap', () => {
  const plan = adPlan(60, { first: 11, every: 24, max: 2 });
  assert.deepEqual([...plan.keys()], [11, 35]);
});

test('formats alternate so a long page never becomes a column of boxes', () => {
  const plan = adPlan(50, { first: 3, every: 12, max: 3 });
  assert.deepEqual([...plan.values()], [AD_MREC, AD_TEXT, AD_MREC]);
});

test('max is a hard ceiling however long the list runs', () => {
  assert.equal(adPlan(500, { first: 3, every: 5, max: 3 }).size, 3);
});

test('no unit is ever placed after the last item', () => {
  const total = 20;
  for (const index of adPlan(total, { first: 3, every: 4, max: 10 }).keys()) {
    assert.ok(index < total - 1, `slot at ${index} would render below the last item`);
  }
});

test('a caller can pin a single format', () => {
  const plan = adPlan(40, { first: 8, every: 20, max: 2, formats: [AD_TEXT] });
  assert.deepEqual([...plan.values()], [AD_TEXT, AD_TEXT]);
});

test('a feed page places its ads exactly where the feed document will', () => {
  // The whole reason feedAdPlan exists. /phoenix-fm and /phoenix-fm.rss list
  // the same posts, so they must advertise at the same points — anything else
  // and the site tells one story to a reader and another to a subscriber.
  for (const total of [0, 9, 10, 11, 20, 30, 50, 200]) {
    assert.deepEqual(
      [...feedAdPlan(total).keys()],
      adPositions(total),
      `total=${total}`,
    );
  }
});

test('a ten-post blog page carries one unit, not none', () => {
  // Ten is the commonest length in the directory by a wide margin, and the old
  // plan gave every one of those pages nothing: the only slot fell after the
  // last post and was dropped rather than moved.
  const plan = feedAdPlan(10);
  assert.deepEqual([...plan.keys()], [8]);
  assert.deepEqual([...plan.values()], [AD_MREC]);
});

test('the feed page still alternates formats, and never trails the list', () => {
  const plan = feedAdPlan(50);
  assert.deepEqual([...plan.values()], [AD_MREC, AD_TEXT, AD_MREC]);
  for (const index of plan.keys()) {
    assert.ok(index < 50 - 1, `slot at ${index} would render below the last post`);
  }
});
