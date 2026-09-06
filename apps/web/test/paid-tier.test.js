import test from 'node:test';
import assert from 'node:assert/strict';

import { mintPass } from '@profullstack/x402-gateway';

import { TIERS } from '../src/lib/tiers.js';

/**
 * The pass rung, and the thing it fixes.
 *
 * Until now /crawl sold a pass that bought a training crawler past the 402 and
 * then met the same 600-an-hour throttle as an anonymous curl. The pass is now
 * a rung on the ladder, so the thing we sell buys something a caller can feel.
 *
 * `hasValidPass` is imported lazily inside each test: lib/crawl-gateway.js
 * reads COINPAY_X402_KEY at module scope through `env`, and these set it first.
 */
const SECRET = 'cp_live_test_secret_0123456789';

async function passModule() {
  process.env.COINPAY_X402_KEY = SECRET;
  return import('../src/lib/crawl-gateway.js');
}

const withHeaders = (headers) =>
  new Request('https://rssamplifier.com/topics/anything', { headers: new Headers(headers) });

async function livePass() {
  const now = Math.floor(Date.now() / 1000);
  const { token } = await mintPass({ secret: SECRET, ref: 'test', expiresAt: now + 3600, now });
  return token;
}

test('a pass sits at the sponsor ceiling, not above it', () => {
  // A sponsored key is a relationship and a pass is a dollar. There is no
  // honest reason the dollar should out-rank the relationship.
  assert.equal(TIERS.pass.hourly, TIERS.sponsor.hourly);
  assert.equal(TIERS.pass.burst, TIERS.sponsor.burst);
});

test('a pass is worth far more than signing in, or nobody would buy one', () => {
  assert.ok(
    TIERS.pass.hourly > TIERS.session.hourly,
    'a bought pass must beat the free account tier',
  );
  assert.ok(TIERS.pass.hourly > TIERS.anon.hourly * 100);
});

test('a live pass in the header is recognised', async () => {
  const { hasValidPass } = await passModule();
  const token = await livePass();
  assert.equal(await hasValidPass(withHeaders({ 'x-crawl-pass': token })), true);
});

test('a live pass presented as a bearer token is recognised', async () => {
  // The gateway accepts both spellings, so the throttle must agree with it or
  // a caller doing exactly what the sales page said gets throttled anyway.
  const { hasValidPass } = await passModule();
  const token = await livePass();
  assert.equal(await hasValidPass(withHeaders({ authorization: `Bearer ${token}` })), true);
});

test('no pass is not a pass', async () => {
  const { hasValidPass } = await passModule();
  assert.equal(await hasValidPass(withHeaders({})), false);
});

test('a forged pass is refused, which is the whole point of signing them', async () => {
  const { hasValidPass } = await passModule();
  const token = await livePass();
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(await hasValidPass(withHeaders({ 'x-crawl-pass': tampered })), false);
});

test('a pass from a different secret is refused', async () => {
  const { hasValidPass } = await passModule();
  const now = Math.floor(Date.now() / 1000);
  const { token } = await mintPass({
    secret: 'someone-elses-key',
    ref: null,
    expiresAt: now + 3600,
    now,
  });
  assert.equal(await hasValidPass(withHeaders({ 'x-crawl-pass': token })), false);
});

test('an expired pass is refused', async () => {
  const { hasValidPass } = await passModule();
  const now = Math.floor(Date.now() / 1000);
  // Minted live, then judged from a moment after it lapsed.
  const { token } = await mintPass({ secret: SECRET, ref: null, expiresAt: now + 1, now });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await hasValidPass(withHeaders({ 'x-crawl-pass': token })), false);
});

test('garbage in the header is not an error, just not a pass', async () => {
  const { hasValidPass } = await passModule();
  for (const value of ['', '   ', 'cp_', 'cp_nodot', 'not-a-pass', 'Bearer nonsense']) {
    assert.equal(
      await hasValidPass(withHeaders({ 'x-crawl-pass': value })),
      false,
      JSON.stringify(value),
    );
  }
});

test('the sales page lists what a pass buys, and every line of it is rate', async () => {
  // The directory's position is that data is open and money buys speed. A
  // benefits list promising fields or endpoints the free tier cannot have would
  // sell the opposite of what this site is for.
  const { gateway } = await passModule();
  const benefits = gateway.options.benefits;
  assert.ok(Array.isArray(benefits) && benefits.length > 0, 'a pass has to say what it buys');
  assert.ok(
    benefits.some((line) => /120,000 requests an hour/.test(line)),
    'the headline number belongs in the list',
  );
  assert.ok(
    benefits.some((line) => /rate, never access/.test(line)),
    'and so does the promise that nothing is withheld',
  );
});
