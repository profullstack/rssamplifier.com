import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AD_MREC, AD_TEXT, adPlan } from '../src/lib/ads.js';

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
