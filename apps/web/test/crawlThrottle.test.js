import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

import { attempt, callerIdentity, callerAddress, reset, LIMITS } from '../src/lib/crawlThrottle.js';

beforeEach(() => reset());

const T0 = 1_700_000_000_000;

/** Spend the whole free allowance, returning the clock afterwards. */
function exhaust(identity, from = T0) {
  let now = from;
  for (let i = 0; i < LIMITS.FREE_PER_WINDOW; i++) attempt(identity, (now += 1));
  return now;
}

test('the allowance passes untouched', () => {
  let now = T0;
  for (let i = 1; i <= LIMITS.FREE_PER_WINDOW; i++) {
    assert.equal(attempt('a', (now += 1)).ok, true, `request ${i} should pass`);
  }
});

test('the request past the allowance is locked, and the lock is the base penalty', () => {
  const now = exhaust('a');

  const v = attempt('a', now + 1);
  assert.equal(v.ok, false);
  assert.equal(v.retryAfter, LIMITS.BASE_LOCK_MS / 1000, 'first penalty is the base');
});

test('each further trip doubles the penalty', () => {
  const seen = [];
  let now = exhaust('a');

  // Each round: wait out the current lock, spend the fresh window, earn a
  // longer lock. The window resets while locked, so the allowance is spent
  // again before the next trip.
  for (let round = 0; round < 4; round++) {
    const v = attempt('a', (now += 1));
    assert.equal(v.ok, false, `round ${round} should refuse`);
    seen.push(v.retryAfter);
    now = v.lockedUntil + 1;
    now = exhaust('a', now);
  }

  assert.deepEqual(seen, [60, 120, 240, 480], 'penalties double: one minute, two, four, eight');
});

test('the penalty is capped', () => {
  let now = exhaust('a');
  let last = 0;

  // Far more rounds than it takes to reach the ceiling.
  for (let round = 0; round < 12; round++) {
    const v = attempt('a', (now += 1));
    last = v.retryAfter;
    now = v.lockedUntil + 1;
    now = exhaust('a', now);
  }

  assert.equal(last, LIMITS.MAX_LOCK_MS / 1000, 'never exceeds the ceiling');
});

test('decay outlasts the longest lock, so the ramp cannot flatten', () => {
  // The invariant authThrottle paid for: if strikes decayed before the ceiling
  // was reached, waiting out a lock would forgive the caller and the escalation
  // would silently become a fixed window.
  assert.ok(
    LIMITS.DECAY_MS > LIMITS.MAX_LOCK_MS,
    'DECAY_MS must exceed MAX_LOCK_MS or the escalation flattens',
  );
});

test('knocking while locked does not escalate the penalty', () => {
  let now = exhaust('a');

  const first = attempt('a', (now += 1));
  assert.equal(first.ok, false);

  // Hammer throughout the lock. None of it should lengthen the sentence.
  for (let i = 0; i < 50; i++) attempt('a', (now += 100));

  const still = attempt('a', now + 1);
  assert.equal(still.ok, false);
  assert.equal(still.lockedUntil, first.lockedUntil, 'the lock is unchanged by knocking');
  assert.equal(still.strikes, first.strikes, 'and no extra strike was charged');
});

test('a quiet caller is forgiven', () => {
  const now = exhaust('a');
  const locked = attempt('a', now + 1);
  assert.equal(locked.ok, false);

  const later = locked.lockedUntil + LIMITS.DECAY_MS + 1;
  const back = attempt('a', later);
  assert.equal(back.ok, true, 'a caller that went away comes back clean');
  assert.equal(back.strikes, 0);
});

test('the allowance is a rate, not a lifetime total', () => {
  let now = exhaust('a');

  // A new window, without ever tripping: a steady caller under the rate runs
  // for ever.
  now += LIMITS.WINDOW_MS + 1;
  assert.equal(attempt('a', now).ok, true, 'the window resets');
});

test('callers are metered separately', () => {
  const now = exhaust('a');
  assert.equal(attempt('a', now + 1).ok, false);
  assert.equal(attempt('b', now + 2).ok, true, 'one caller cannot lock out another');
});

test('a declared crawler is one caller across every address it uses', () => {
  // The reason this file exists in the shape it does: Meta crawled from 70
  // addresses at a per-address rate no sane limit would ever catch.
  const meta = (ip) =>
    new Request('https://rssamplifier.com/login', {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))',
        'x-forwarded-for': ip,
      },
    });

  assert.equal(callerIdentity(meta('57.141.2.73')), 'bot:meta-externalagent');
  assert.equal(
    callerIdentity(meta('57.141.2.24')),
    callerIdentity(meta('57.141.2.99')),
    'the whole fleet shares one bucket',
  );
});

test('an undeclared caller is metered per address', () => {
  const browser = (ip) =>
    new Request('https://rssamplifier.com/', {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'x-forwarded-for': ip,
      },
    });

  assert.equal(callerIdentity(browser('141.94.94.32')), 'ip:141.94.94.32');
  assert.notEqual(
    callerIdentity(browser('141.94.94.32')),
    callerIdentity(browser('141.94.94.40')),
    'a spoofed browser UA gets no fleet-wide bucket — and no fleet-wide limit either',
  );
});

test('only the first forwarded address is trusted', () => {
  const req = new Request('https://rssamplifier.com/', {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 192.168.1.1' },
  });
  assert.equal(callerAddress(req), '203.0.113.9');
});

test('the measured crawl rates land on the right side of the line', () => {
  // Sampled 2026-08-28. These are the numbers the allowance was sized against,
  // kept here so that changing FREE_PER_WINDOW has to face them.
  const perMinute = (reqs, seconds) => (reqs / seconds) * 60;

  assert.ok(perMinute(1325, 154) > LIMITS.FREE_PER_WINDOW, 'ClaudeBot is throttled');
  assert.ok(perMinute(669, 154) > LIMITS.FREE_PER_WINDOW, "Meta's fleet is throttled");
  // A person reading steadily — a page and its parts every few seconds.
  assert.ok(perMinute(30, 60) < LIMITS.FREE_PER_WINDOW, 'a reader is not');
});
