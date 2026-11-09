import assert from 'node:assert/strict';
import { test } from 'node:test';

import { interleaveTiers, spreadHosts } from '../src/crawl.js';

test('a batch cut from the front of the pool keeps every tier, not just hot', () => {
  // The pool as dueFeeds returns it: tier by tier, each its quota times three.
  const rows = (tier, n, interval) =>
    Array.from({ length: n }, (_, i) => ({ slug: `${tier}-${i}`, feed_url: `https://${tier}${i}.example/f`, fetch_interval_minutes: interval }));
  const pool = [...rows('hot', 108, 60), ...rows('active', 81, 380), ...rows('slow', 48, 3000), ...rows('dormant', 27, 10080), ...rows('archived', 6, 20000)];

  const before = spreadHosts(pool, 90, 8);
  assert.ok(before.every((r) => r.slug.startsWith('hot-')), 'the bug: hot alone filled the batch');

  const batch = spreadHosts(interleaveTiers(pool), 90, 8);
  const count = (t) => batch.filter((r) => r.slug.startsWith(`${t}-`)).length;
  assert.equal(count('hot'), 36);
  assert.equal(count('active'), 27);
  assert.ok(count('slow') >= 15 && count('dormant') >= 8 && count('archived') >= 1);
  assert.equal(batch.find((r) => r.slug.startsWith('active-')).slug, 'active-0', 'oldest due first within a tier');
});
