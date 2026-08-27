import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

import { attempt, forgive, reset, LIMITS, callerAddress } from '../src/lib/authThrottle.js';

beforeEach(() => reset());

const T0 = 1_700_000_000_000;

test('the first attempts pass untouched', () => {
  for (let i = 1; i <= LIMITS.FREE_ATTEMPTS; i++) {
    assert.equal(attempt('a', T0 + i).ok, true, `attempt ${i} should pass`);
  }
});

test('the attempt past the allowance is locked, and the lock is the base penalty', () => {
  for (let i = 1; i <= LIMITS.FREE_ATTEMPTS; i++) attempt('a', T0 + i);

  const v = attempt('a', T0 + 100);
  assert.equal(v.ok, false);
  assert.equal(v.retryAfter, LIMITS.BASE_LOCK_MS / 1000, 'first penalty is the base');
});

test('each further trip doubles the penalty', () => {
  const seen = [];
  let now = T0;

  for (let i = 1; i <= LIMITS.FREE_ATTEMPTS; i++) attempt('a', (now += 1));

  // Each round: wait out the current lock, try once more, earn a longer one.
  for (let round = 0; round < 4; round++) {
    const v = attempt('a', (now += 1));
    assert.equal(v.ok, false);
    seen.push(v.retryAfter);
    now = v.lockedUntil + 1;
  }

  assert.deepEqual(
    seen,
    [60, 120, 240, 480],
    'penalties double: one minute, two, four, eight',
  );
});

test('knocking while locked does not escalate the penalty', () => {
  // Otherwise a script hammering once a second reaches the day-long ceiling in
  // under a minute, and a person retrying twice is treated as an attacker.
  let now = T0;
  for (let i = 1; i <= LIMITS.FREE_ATTEMPTS; i++) attempt('a', (now += 1));

  const first = attempt('a', (now += 1));
  for (let i = 0; i < 50; i++) attempt('a', (now += 1));

  // Wait out that lock; the next trip should be exactly one doubling on.
  const next = attempt('a', first.lockedUntil + 1);
  assert.equal(next.retryAfter, first.retryAfter * 2, 'escalated once, not fifty times');
});

test('the penalty is capped', () => {
  let now = T0;
  for (let i = 1; i <= LIMITS.FREE_ATTEMPTS; i++) attempt('a', (now += 1));

  let v = attempt('a', (now += 1));
  for (let round = 0; round < 40; round++) v = attempt('a', v.lockedUntil + 1);

  assert.equal(v.retryAfter, LIMITS.MAX_LOCK_MS / 1000, 'never exceeds the ceiling');
  assert.ok(Number.isFinite(v.retryAfter), 'and never overflows to Infinity');
});

test('a quiet caller is forgiven', () => {
  let now = T0;
  for (let i = 1; i <= LIMITS.FREE_ATTEMPTS; i++) attempt('a', (now += 1));
  const locked = attempt('a', (now += 1));
  assert.equal(locked.ok, false);

  const later = locked.lockedUntil + LIMITS.DECAY_MS + 1;
  assert.equal(attempt('a', later).ok, true, 'starts again with a clean slate');
});

test('callers are metered separately', () => {
  let now = T0;
  for (let i = 1; i <= LIMITS.FREE_ATTEMPTS + 1; i++) attempt('a', (now += 1));
  assert.equal(attempt('a', (now += 1)).ok, false, 'a is locked');
  assert.equal(attempt('b', (now += 1)).ok, true, 'b is unaffected');
});

test('a successful sign-in clears the caller', () => {
  let now = T0;
  for (let i = 1; i <= LIMITS.FREE_ATTEMPTS; i++) attempt('a', (now += 1));
  forgive('a');
  assert.equal(attempt('a', (now += 1)).ok, true, 'fumbled links before a real one are forgiven');
});

test('the caller is the first x-forwarded-for entry, not the last', () => {
  // Getting this wrong collapses every visitor onto one identity, and the first
  // five requests in the world lock out everybody.
  const req = new Request('https://rssamplifier.com/auth/magic', {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' },
  });
  assert.equal(callerAddress(req), '203.0.113.9');
});

test('a request with no forwarding header still yields one identity', () => {
  const req = new Request('https://rssamplifier.com/auth/magic');
  assert.equal(callerAddress(req), 'unknown');
});
