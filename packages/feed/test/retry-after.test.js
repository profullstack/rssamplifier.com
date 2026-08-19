import assert from 'node:assert/strict';
import { test } from 'node:test';

import { retryAfterSeconds } from '../src/fetch.js';

test('a delay in seconds is read as seconds', () => {
  assert.equal(retryAfterSeconds('120'), 120);
  assert.equal(retryAfterSeconds(' 45 '), 45);
  assert.equal(retryAfterSeconds('0'), 0);
});

test('an HTTP date is read as the wait until then', () => {
  // RFC 9110 permits either form and both are sent in the wild.
  const at = new Date(Date.now() + 90_000).toUTCString();
  const seconds = retryAfterSeconds(at);
  assert.ok(seconds >= 85 && seconds <= 95, `expected ~90, got ${seconds}`);
});

test('a date already past is no wait at all, never a negative one', () => {
  const at = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(retryAfterSeconds(at), 0);
});

test('nothing to read is null, so the caller can choose its own default', () => {
  assert.equal(retryAfterSeconds(null), null);
  assert.equal(retryAfterSeconds(''), null);
  assert.equal(retryAfterSeconds('soon'), null);
});

test('an absurd wait is clamped to a day', () => {
  // A server asking for a month has almost certainly sent a header we misread,
  // and honouring it literally would retire the feed.
  assert.equal(retryAfterSeconds('9999999'), 86_400);
});
