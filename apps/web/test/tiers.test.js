import test from 'node:test';
import assert from 'node:assert/strict';

import { hashToken } from '@rssamplifier/auth';

import { TIERS, tierFor, resetTierCache, primeKey } from '../src/lib/tiers.js';
import { attempt, reset, LIMITS } from '../src/lib/crawlThrottle.js';

/**
 * A request as the proxy sees one. `cookies` is the NextRequest accessor; the
 * header fallback in `tierFor` is exercised separately.
 *
 * @param {{ cookie?: string, headers?: Record<string,string> }} [opts]
 */
function req({ cookie, headers = {} } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set('cookie', cookie);
  const r = new Request('https://rssamplifier.com/topics', { headers: h });
  return r;
}

test('the ladder is free, then ten times free, then the server ceiling', () => {
  assert.equal(TIERS.session.hourly, TIERS.anon.hourly * 10);
  assert.ok(
    TIERS.sponsor.hourly > TIERS.session.hourly,
    'a sponsor must be worth more than a free account',
  );
});

test('signing in is worth something, which means signed-in cannot be unmetered', () => {
  // The regression this guards: signed-in used to skip metering entirely. An
  // unmetered rung means the ladder tops out at "make a free account" and
  // nothing above it can ever be worth paying for.
  assert.ok(Number.isFinite(TIERS.session.hourly), 'the session tier has a real ceiling');
  assert.ok(Number.isFinite(TIERS.sponsor.hourly), 'even the sponsor ceiling is finite');
});

test('no cookie and no key is the free tier', () => {
  resetTierCache();
  assert.equal(tierFor(req()).name, 'anon');
});

test('a session cookie moves a caller up one rung', () => {
  resetTierCache();
  assert.equal(tierFor(req({ cookie: 'rsa_session=abc123' })).name, 'session');
});

test('an emptied session cookie is not a session', () => {
  resetTierCache();
  assert.equal(tierFor(req({ cookie: 'rsa_session=' })).name, 'anon');
});

test('a cookie that merely mentions the name is not a session', () => {
  resetTierCache();
  assert.equal(tierFor(req({ cookie: 'not_rsa_session=abc' })).name, 'anon');
});

/**
 * A correctly *shaped* key: `rsa_<8 hex>_<20+ chars>`.
 *
 * Shape matters to these tests. A malformed token is rejected by
 * `looksLikeApiKey` before the cache is ever consulted, so a test written with
 * a plausible-looking-but-wrong string passes without exercising the key path
 * at all — and would go on passing if the sponsor tier were unreachable.
 */
const GOOD_SHAPE = 'rsa_a1b2c3d4_abcdefghijklmnopqrstuvwxyz';

test('the sponsor tier is actually reachable with a verified key', () => {
  // The test that proves the top rung is not dead code.
  resetTierCache();
  primeKey(hashOf(GOOD_SHAPE), true);

  assert.equal(
    tierFor(req({ headers: { authorization: `Bearer ${GOOD_SHAPE}` } })).name,
    'sponsor',
  );
});

test('the key may arrive as x-api-key too', () => {
  resetTierCache();
  primeKey(hashOf(GOOD_SHAPE), true);
  assert.equal(tierFor(req({ headers: { 'x-api-key': GOOD_SHAPE } })).name, 'sponsor');
});

test('an unverified key does not buy the sponsor tier', () => {
  // The important direction. A key is verified against the database behind the
  // request, so until that lands the caller is metered *down*, never up --
  // otherwise anyone could mint sponsor throughput by inventing a token.
  resetTierCache();
  const tier = tierFor(req({ headers: { authorization: `Bearer ${GOOD_SHAPE}` } }));
  assert.notEqual(tier.name, 'sponsor', 'an unchecked key is not yet a sponsor');
});

test('a key known to be bad stays on the free tier', () => {
  resetTierCache();
  primeKey(hashOf(GOOD_SHAPE), false);
  assert.equal(
    tierFor(req({ headers: { authorization: `Bearer ${GOOD_SHAPE}` } })).name,
    'anon',
  );
});

test('a malformed key is not even looked up', () => {
  resetTierCache();
  assert.equal(tierFor(req({ headers: { authorization: 'Bearer not-a-key' } })).name, 'anon');
});

test('a signed-in caller presenting a verified key gets the higher rung', () => {
  // Order matters: the key is checked before the cookie, so a sponsor testing
  // from a signed-in browser is not silently demoted to the session tier.
  resetTierCache();
  primeKey(hashOf(GOOD_SHAPE), true);

  const tier = tierFor(
    req({ cookie: 'rsa_session=abc', headers: { authorization: `Bearer ${GOOD_SHAPE}` } }),
  );
  assert.equal(tier.name, 'sponsor');
});

test('the free burst allowance is unchanged by any of this', () => {
  // The per-minute figure was sized against human browsing and that reasoning
  // is untouched. Only the sustained budget is new.
  assert.equal(TIERS.anon.burst, LIMITS.FREE_PER_WINDOW);
});

test('an hourly budget refuses once spent, even inside the burst allowance', () => {
  reset();
  let now = Date.now();
  const allowance = { burst: 1_000_000, hourly: 5 };

  for (let i = 1; i <= 5; i++) {
    assert.equal(attempt('h', (now += 1), allowance).ok, true, `request ${i}`);
  }

  const spent = attempt('h', (now += 1), allowance);
  assert.equal(spent.ok, false, 'the sixth is over budget');
  assert.ok(spent.retryAfter > 0, 'and is told when to come back');
});

test('spending an hourly budget earns no strike and no escalating lock', () => {
  // A burst is a caller misbehaving now; an exhausted budget is a pricing
  // question. Answering the second with the first would punish a crawler for
  // politely staying at its limit.
  reset();
  let now = Date.now();
  const allowance = { burst: 1_000_000, hourly: 2 };

  attempt('i', (now += 1), allowance);
  attempt('i', (now += 1), allowance);

  const first = attempt('i', (now += 1), allowance);
  const second = attempt('i', (now += 1), allowance);

  assert.equal(first.strikes, 0);
  assert.equal(second.strikes, 0, 'knocking does not escalate a budget refusal');
  assert.equal(second.lockedUntil, 0, 'and does not lock');
});

test('the hourly budget rolls over', () => {
  reset();
  let now = Date.now();
  const allowance = { burst: 1_000_000, hourly: 2 };

  attempt('j', now, allowance);
  attempt('j', now + 1, allowance);
  assert.equal(attempt('j', now + 2, allowance).ok, false);

  const later = now + LIMITS.HOUR_MS + 1;
  assert.equal(attempt('j', later, allowance).ok, true, 'a new hour is a new budget');
});

test('the burst still bites inside a generous hourly budget', () => {
  reset();
  let now = Date.now();
  const allowance = { burst: 3, hourly: 1_000_000 };

  for (let i = 0; i < 3; i++) attempt('k', (now += 1), allowance);

  const over = attempt('k', (now += 1), allowance);
  assert.equal(over.ok, false, 'the burst ceiling still applies');
  assert.equal(over.strikes, 1, 'and a burst does earn a strike');
});

test('remaining reports whichever allowance runs out first', () => {
  reset();
  const now = Date.now();
  const verdict = attempt('l', now, { burst: 100, hourly: 4 });
  assert.equal(verdict.remaining, 3, 'the hourly budget is the binding one here');
});

test('a caller with no tier is metered exactly as before tiering existed', () => {
  // The compatibility guarantee: two-argument callers keep the old behaviour,
  // which is what lets the 322 tests that predate this go on passing.
  reset();
  let now = Date.now();
  for (let i = 1; i <= LIMITS.FREE_PER_WINDOW; i++) {
    assert.equal(attempt('m', (now += 1)).ok, true, `request ${i} passes`);
  }
  assert.equal(attempt('m', (now += 1)).ok, false, 'and the burst still applies');
});

test('the tiers are separately metered, so one does not spend another', () => {
  reset();
  let now = Date.now();
  const small = { burst: 1_000_000, hourly: 2 };

  attempt('anon:x', now, small);
  attempt('anon:x', now + 1, small);
  assert.equal(attempt('anon:x', now + 2, small).ok, false);

  assert.equal(
    attempt('sponsor:y', now + 3, TIERS.sponsor).ok,
    true,
    'a different caller is unaffected',
  );
});

/** The same hash the guard stores keys under. @param {string} token */
function hashOf(token) {
  return hashToken(token);
}
