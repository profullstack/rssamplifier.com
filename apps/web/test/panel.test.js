import assert from 'node:assert/strict';
import { test } from 'node:test';

import { panel } from '../src/lib/crawlstats.js';

test('a panel read that rejects falls back', async () => {
  const got = await panel(Promise.reject(new Error('down')), 'FALLBACK');
  assert.equal(got, 'FALLBACK');
});

test('a panel read that answers is passed through', async () => {
  const got = await panel(Promise.resolve('REAL'), 'FALLBACK');
  assert.equal(got, 'REAL');
});

test('a panel read that never answers still falls back', async () => {
  // The failure this bound was added for. `panel` caught rejection and nothing
  // else, so a libSQL request that simply never returns -- which this database
  // demonstrably does -- left the page's only `await` unsettled for ever. The
  // symptom was zero bytes sent, not a slow page: /crawlstats sent nothing in
  // 120s while /api/crawlstats answered in 2.39s.
  const started = Date.now();
  const got = await panel(new Promise(() => {}), 'FALLBACK', 50);
  assert.equal(got, 'FALLBACK', 'gave up and used the fallback');
  assert.ok(Date.now() - started < 2_000, `returned promptly, took ${Date.now() - started}ms`);
});

test('the bound does not trim a read that is merely slower than nothing', async () => {
  // Guards against setting this so tight it starts discarding working reads:
  // the real ones are 90-572ms against a 5s default.
  const slowish = new Promise((r) => setTimeout(() => r('REAL'), 20));
  assert.equal(await panel(slowish, 'FALLBACK', 1_000), 'REAL');
});
