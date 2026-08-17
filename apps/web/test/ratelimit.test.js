import test from 'node:test';
import assert from 'node:assert/strict';

import { consume, limitHeaders, reset, ANONYMOUS_HOURLY } from '../src/lib/ratelimit.js';

const NOW = Date.parse('2026-08-17T12:00:00Z');

test('a caller under its limit is allowed and told what is left', () => {
  reset();
  const first = consume('key:a', 3, NOW);

  assert.equal(first.ok, true);
  assert.equal(first.limit, 3);
  assert.equal(first.remaining, 2);
});

test('the limit is the last request allowed, not the first refused', () => {
  reset();
  assert.equal(consume('key:b', 2, NOW).ok, true);
  assert.equal(consume('key:b', 2, NOW).ok, true);
  assert.equal(consume('key:b', 2, NOW).ok, false, 'the third request is over a limit of two');
});

test('remaining never goes negative', () => {
  reset();
  for (let i = 0; i < 5; i += 1) consume('key:c', 1, NOW);
  assert.equal(consume('key:c', 1, NOW).remaining, 0);
});

test('callers are counted apart', () => {
  reset();
  consume('key:d', 1, NOW);

  assert.equal(consume('key:e', 1, NOW).ok, true, "one caller's usage must not spend another's");
});

test('the window reopens once it has passed', () => {
  reset();
  assert.equal(consume('key:f', 1, NOW).ok, true);
  assert.equal(consume('key:f', 1, NOW).ok, false);

  const later = NOW + 3_600_001;
  assert.equal(consume('key:f', 1, later).ok, true, 'a fresh hour is a fresh allowance');
});

test('retryAfter is a positive number of seconds', () => {
  reset();
  const verdict = consume('key:g', 1, NOW);

  assert.ok(verdict.retryAfter > 0);
  assert.ok(verdict.retryAfter <= 3600);
});

test('the headers say the limit, what is left and when it resets', () => {
  reset();
  const headers = limitHeaders(consume('key:h', 10, NOW));

  assert.equal(headers['x-ratelimit-limit'], '10');
  assert.equal(headers['x-ratelimit-remaining'], '9');
  assert.equal(headers['x-ratelimit-reset'], String(Math.ceil((NOW + 3_600_000) / 1000)));
});

test('the anonymous allowance is enough to do real work', () => {
  // This directory exists to be read without asking permission. If this number
  // ever gets tightened to the point of being a sales tactic, that promise has
  // quietly been broken.
  assert.ok(ANONYMOUS_HOURLY >= 500, `anonymous callers get ${ANONYMOUS_HOURLY}/hour`);
});
