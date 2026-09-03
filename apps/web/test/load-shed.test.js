import test from 'node:test';
import assert from 'node:assert/strict';

import { admit, inflight, limit, reset } from '../src/lib/loadShed.js';

/**
 * The in-flight ceiling.
 *
 * What it must get right is the accounting, because the failure of a counter
 * that drifts is silent: a slot freed twice raises the cap by one forever, and
 * a slot never freed lowers it, until a quiet afternoon the process refuses
 * everything with nothing in flight.
 */

test.beforeEach(() => {
  delete process.env.WEB_MAX_INFLIGHT;
  reset();
});

test('admits up to the limit and refuses the next', () => {
  process.env.WEB_MAX_INFLIGHT = '3';

  const releases = [admit('/a'), admit('/b'), admit('/c')];
  assert.ok(releases.every((r) => typeof r === 'function'), 'the first three are in');

  assert.equal(admit('/d'), null, 'the fourth is refused');
  assert.equal(inflight().active, 3);
  assert.equal(inflight().refused, 1);
});

test('a released slot is admitted again', () => {
  process.env.WEB_MAX_INFLIGHT = '1';

  const release = admit('/a');
  assert.equal(admit('/b'), null);

  release();
  assert.equal(inflight().active, 0);
  assert.ok(admit('/b'), 'room again once the first request finished');
});

test('releasing twice frees one slot, not two', () => {
  process.env.WEB_MAX_INFLIGHT = '1';

  const release = admit('/a');
  release();
  release();

  assert.equal(inflight().active, 0, 'never negative');
  assert.ok(admit('/b'));
  assert.equal(admit('/c'), null, 'the cap did not quietly rise');
});

test('assets are served whatever the load, and never counted', () => {
  process.env.WEB_MAX_INFLIGHT = '1';

  admit('/some-page');
  for (const asset of [
    '/_next/static/chunks/app.js',
    '/icons/icon-192x192.png',
    '/favicon.ico',
    '/manifest.webmanifest',
    '/sw.js',
    '/robots.txt',
  ]) {
    const release = admit(asset);
    assert.ok(release, `${asset} is served under load`);
    release();
  }

  assert.equal(inflight().active, 1, 'only the page counted');
  assert.equal(inflight().refused, 0);
});

test('a look-alike of an asset path is a page', () => {
  process.env.WEB_MAX_INFLIGHT = '1';

  admit('/some-page');
  assert.equal(admit('/icons-and-more'), null);
  assert.equal(admit('/favicon.ico.html'), null);
  assert.equal(admit('/some/_next/static/x.js'), null);
});

test('the limit comes from the environment, and junk falls back to the default', () => {
  assert.equal(limit(), 128);

  process.env.WEB_MAX_INFLIGHT = '40';
  assert.equal(limit(), 40);

  for (const junk of ['0', '-5', 'lots', '', '1.5']) {
    process.env.WEB_MAX_INFLIGHT = junk;
    assert.equal(limit(), 128, `${JSON.stringify(junk)} does not remove the limit`);
  }
});
