import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The proof-of-work challenge.
 *
 * Two failures are worth more than the rest, and both are silent.
 *
 * The first is challenging someone we promised not to. A feed reader that gets
 * an interstitial where its `.rss` used to be does not complain; it simply
 * stops updating, for as long as nobody notices. Same for a search crawler, an
 * agent on `/api/*`, and a signed-in reader. So most of what follows is about
 * who is *not* asked.
 *
 * The second is a check that costs a real reader a second and costs the fleet
 * nothing — a forgeable token, a token that outlives its cost, a token solved
 * on one address and spent on another, or a difficulty that quietly fell to
 * zero because someone typed a variable wrong. Those are the acceptance tests
 * at the bottom.
 */

const SECRET = 'test-secret-not-a-real-one';

/** The environment the feature is actually on in. @param {Record<string,string>} [extra] */
function on(extra = {}) {
  process.env.CHALLENGE_ENABLED = '1';
  process.env.CHALLENGE_SECRET = SECRET;
  process.env.CHALLENGE_BITS = '8';
  delete process.env.CHALLENGE_TTL_MINUTES;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

function off() {
  delete process.env.CHALLENGE_ENABLED;
  delete process.env.CHALLENGE_SECRET;
  delete process.env.CHALLENGE_BITS;
  delete process.env.CHALLENGE_TTL_MINUTES;
}

/** A request as the edge presents it. */
function req(path, { ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/145.0.0.0', ip = '203.0.113.7', cookie, auth, method = 'GET' } = {}) {
  const headers = new Headers({ 'user-agent': ua, 'x-real-ip': ip });
  if (cookie) headers.set('cookie', cookie);
  if (auth) headers.set('authorization', auth);
  return new Request(`https://rssamplifier.com${path}`, { method, headers });
}

const { SHA256_JS, bits, challenge, enabled, hasLeadingZeroBits, seedFor, solved, wouldChallenge } =
  await import('../src/lib/challenge.js');

test.beforeEach(off);
test.after(off);

/* ------------------------------------------------------------------ off -- */

test('off by default, so a deploy cannot start interrupting readers on its own', () => {
  assert.equal(enabled(), false);
  assert.equal(wouldChallenge(req('/topics/bing-ai'), '/topics/bing-ai'), false);
});

test('enabled without a secret stays off, because forgeable tokens are worse than none', () => {
  process.env.CHALLENGE_ENABLED = '1';
  assert.equal(enabled(), false, 'a costume of a defence costs readers and stops nobody');

  process.env.CHALLENGE_SECRET = '   ';
  assert.equal(enabled(), false, 'whitespace is not a secret');
});

/* ------------------------------------------------------- who is not asked -- */

test('the API is never challenged', () => {
  on();
  for (const p of ['/api/topics/nfl-season', '/api/authors/zawn-villines', '/api/feeds', '/api/mcp']) {
    assert.equal(wouldChallenge(req(p), p), false, `${p} must stay open to agents`);
  }
});

test('feed exports are never challenged, whatever route they hang off', () => {
  on();
  for (const p of [
    '/topics/bing-ai.rss',
    '/topics/bing-ai.atom',
    '/topics/otaku-jump/audio.pls',
    '/topics/parallel-computer.m3u',
    '/joereg4-com.json',
    '/opml',
  ]) {
    assert.equal(wouldChallenge(req(p), p), false, `${p} is what a subscriber fetches`);
  }
});

test('only the three expensive page routes are challenged', () => {
  on();
  for (const p of ['/topics/bing-ai', '/authors/mourjo-sen', '/dusty-phillips-codes/read']) {
    assert.equal(wouldChallenge(req(p), p), true, `${p} is what the fleet walks`);
  }
  for (const p of ['/', '/login', '/crawl', '/leaderboard', '/search', '/videos']) {
    assert.equal(wouldChallenge(req(p), p), false, `${p} is not worth interrupting for`);
  }
});

test('a caller who has already said who they are is never challenged', () => {
  on();
  const p = '/topics/bing-ai';

  assert.equal(wouldChallenge(req(p, { cookie: 'rsa_session=abc' }), p), false, 'signed in');
  assert.equal(
    wouldChallenge(req(p, { auth: 'Bearer rsa_1234abcd_aaaaaaaaaaaaaaaaaaaaaa' }), p),
    false,
    'carries an API key',
  );
  assert.equal(
    wouldChallenge(
      req(p, { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }),
      p,
    ),
    false,
    'a search engine that names itself',
  );
});

test('only GET and HEAD, so a form post is never answered with a puzzle', () => {
  on();
  assert.equal(wouldChallenge(req('/topics/x', { method: 'POST' }), '/topics/x'), false);
  assert.equal(wouldChallenge(req('/topics/x', { method: 'HEAD' }), '/topics/x'), true);
});

/* ----------------------------------------------------------- the numbers -- */

test('leading zero bits are counted bit-wise, not by hex digit', () => {
  assert.equal(hasLeadingZeroBits(new Uint8Array([0x00, 0x00, 0xff]), 16), true);
  assert.equal(hasLeadingZeroBits(new Uint8Array([0x00, 0x01]), 16), false);
  assert.equal(hasLeadingZeroBits(new Uint8Array([0x0f]), 4), true, 'half a byte counts');
  assert.equal(hasLeadingZeroBits(new Uint8Array([0x1f]), 4), false);
  assert.equal(hasLeadingZeroBits(new Uint8Array([0xff]), 0), true, 'nothing asked, nothing owed');
});

test('junk in the difficulty falls back to the default, never to zero', () => {
  on({ CHALLENGE_BITS: 'lots' });
  assert.equal(bits(), 18);

  on({ CHALLENGE_BITS: '0' });
  assert.equal(bits(), 18, 'zero bits is a challenge every caller passes for free');

  on({ CHALLENGE_BITS: '-4' });
  assert.equal(bits(), 18);

  on({ CHALLENGE_BITS: '999' });
  assert.equal(bits(), 18, 'a difficulty nobody can solve is an outage');
});

/* ------------------------------------------------------------ acceptance -- */

/** Solve one, the way the browser does. */
async function solve(request, issuedAt, difficulty) {
  const seed = await seedFor(request, issuedAt);
  const enc = new TextEncoder();
  for (let n = 0; n < 5_000_000; n += 1) {
    const d = await crypto.subtle.digest('SHA-256', enc.encode(seed + n));
    if (hasLeadingZeroBits(new Uint8Array(d), difficulty)) return n;
  }
  throw new Error('unsolvable');
}

test('a genuine solution is accepted', async () => {
  on();
  const r = req('/topics/bing-ai');
  const issuedAt = Date.now();
  const nonce = await solve(r, issuedAt, 8);

  const withToken = req('/topics/bing-ai', { cookie: `rsa_pow=${issuedAt}.${nonce}` });
  assert.equal(await solved(withToken), true);
});

test('a made-up answer is refused', async () => {
  on();
  const r = req('/topics/bing-ai', { cookie: `rsa_pow=${Date.now()}.999999999` });
  assert.equal(await solved(r), false, 'any two numbers must not open the door');
});

test('a solution is bound to the address that solved it', async () => {
  on();
  const mine = req('/topics/bing-ai', { ip: '203.0.113.7' });
  const issuedAt = Date.now();
  const nonce = await solve(mine, issuedAt, 8);
  const cookie = `rsa_pow=${issuedAt}.${nonce}`;

  assert.equal(await solved(req('/topics/bing-ai', { ip: '203.0.113.7', cookie })), true);
  assert.equal(
    await solved(req('/topics/bing-ai', { ip: '198.51.100.9', cookie })),
    false,
    'this is the whole cost model: rotating the address means solving again',
  );
});

test('a solution expires, so the tax is paid again', async () => {
  on({ CHALLENGE_TTL_MINUTES: '1' });
  const r = req('/topics/bing-ai');
  const issuedAt = Date.now() - 5 * 60_000;
  const nonce = await solve(r, issuedAt, 8);

  assert.equal(
    await solved(req('/topics/bing-ai', { cookie: `rsa_pow=${issuedAt}.${nonce}` })),
    false,
  );
});

test('a solution to an easier question stops working when the difficulty rises', async () => {
  on({ CHALLENGE_BITS: '4' });
  const r = req('/topics/bing-ai');
  const issuedAt = Date.now();
  const nonce = await solve(r, issuedAt, 4);
  const cookie = `rsa_pow=${issuedAt}.${nonce}`;

  assert.equal(await solved(req('/topics/bing-ai', { cookie })), true);

  // Ten bits is 64x the work; the four-bit answer will almost never satisfy it,
  // and re-solving is exactly what raising the dial is meant to force.
  on({ CHALLENGE_BITS: '10' });
  const stillGood = await solved(req('/topics/bing-ai', { cookie }));
  assert.equal(stillGood, false, 'the difficulty is read now, not taken from the token');
});

test('a token that claims the future is refused', async () => {
  on();
  const ahead = Date.now() + 60 * 60_000;
  assert.equal(await solved(req('/topics/x', { cookie: `rsa_pow=${ahead}.1` })), false);
});

test('junk in the cookie is refused rather than thrown', async () => {
  on();
  for (const v of ['', 'x', '.', 'abc.def', '123', `${Date.now()}.`]) {
    assert.equal(await solved(req('/topics/x', { cookie: `rsa_pow=${v}` })), false, JSON.stringify(v));
  }
});

/* ----------------------------------------------------------- the response -- */

test('the interstitial is a 503 that no crawler will index as the article', async () => {
  on();
  const request = req('/topics/bing-ai');
  request.nextUrl = new URL('https://rssamplifier.com/topics/bing-ai');

  const res = await challenge(request);
  assert.ok(res, 'a challenge is owed');
  assert.equal(res.status, 503, 'a 200 here would be indexed in place of the page');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(res.headers.get('retry-after'));

  const body = await res.text();
  assert.match(body, /llms\.txt/, 'a program is told where the open doors are');
  assert.match(body, /\/login/, 'a person is told how to stop being asked');
  assert.match(body, /noscript/, 'and what to do without JavaScript');
});

test('nothing is owed once it has been solved', async () => {
  on();
  const plain = req('/topics/bing-ai');
  const issuedAt = Date.now();
  const nonce = await solve(plain, issuedAt, 8);

  const request = req('/topics/bing-ai', { cookie: `rsa_pow=${issuedAt}.${nonce}` });
  assert.equal(await challenge(request), null);
});

/* ------------------------------------------------------------ the solver -- */

/**
 * The hash the page ships, checked against the one the server verifies with.
 *
 * This is the failure with no symptom worth naming: a hand-written SHA-256 that
 * is wrong in any bit produces a challenge that can never be solved, and the
 * only sign of it is readers sitting on an interstitial forever while the logs
 * show nothing at all. So the exact text that goes into the page is run here
 * and compared against Web Crypto over inputs that cross both padding
 * boundaries — a message that fits in one block, one that spills into a second,
 * and the 55/56/64-byte edges where the length field moves.
 */
/*
 * Compiled with `new Function` rather than run in a `vm` context, and the
 * difference is not a detail: typed arrays reached across a vm boundary defeat
 * the JIT, and the same text that does 610,000 hashes a second here managed
 * 10,000 inside `vm.runInNewContext`. A benchmark run in a sandbox would have
 * condemned a solver that is perfectly fast in the browser it is written for.
 */
const solver = new Function(`${SHA256_JS}; return { sha256Head, padded };`)();

test('the shipped hash agrees with Web Crypto, including at the padding edges', async () => {
  const enc = new TextEncoder();
  const cases = ['', 'a', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(200), 'deadbeef1234567890'];

  for (const s of cases) {
    const bytes = enc.encode(s);
    const real = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const expected = ((real[0] << 24) | (real[1] << 16) | (real[2] << 8) | real[3]) >>> 0;

    const { buf, blocks } = solver.padded(bytes, 0);
    assert.equal(solver.sha256Head(buf, blocks), expected, `SHA-256 of ${s.length} bytes must match`);
  }
});

test('the solver is fast enough that the default difficulty is bearable', () => {
  const bytes = new TextEncoder().encode('benchmark-seed-0123456789012345678901234567890123456789012345678901');
  const { buf, blocks } = solver.padded(bytes, 0);

  const started = Date.now();
  const N = 50_000;
  for (let i = 0; i < N; i += 1) solver.sha256Head(buf, blocks);
  const perSecond = N / ((Date.now() - started) / 1000 || 0.001);

  // The 18-bit default averages 262,144 hashes. Web Crypto managed ~67k/s,
  // which would have made a reader wait eight seconds, and the first version of
  // this hash managed 17k/s — worse than what it replaced. Well under a second
  // at the default is the bar, so this has to clear a few hundred thousand.
  assert.ok(perSecond > 300_000, `only ${Math.round(perSecond)} hashes/s — too slow to ask a reader for`);
});

/* --------------------------------------------------------------- wiring -- */

/**
 * Where the challenge sits in the proxy, read out of proxy.js itself.
 *
 * proxy.js cannot be imported here — it pulls in `next/server`, which has no
 * export map plain Node can resolve — so its shape is read back from the
 * source, the way test/crawl-gateway.test.js reads the gate's position. The
 * order is the policy: a training crawler is owed a 402 and an offer rather
 * than a puzzle, and the throttle must not get to refuse a caller we were about
 * to challenge, because the whole premise here is that the throttle cannot see
 * this traffic.
 */
function proxySource() {
  return readFileSync(fileURLToPath(new URL('../src/proxy.js', import.meta.url)), 'utf8');
}

test('the challenge runs after the gate and before the throttle', () => {
  const src = proxySource();
  const gateAt = src.indexOf('await gate(request)');
  const challengeAt = src.indexOf('await challenge(request)');
  const throttleAt = src.indexOf('attempt(callerIdentity(request)');

  assert.ok(gateAt >= 0 && challengeAt >= 0 && throttleAt >= 0, 'all three still run');
  assert.ok(gateAt < challengeAt, 'a training crawler is owed the offer, not a puzzle');
  assert.ok(challengeAt < throttleAt, 'the throttle must not answer a caller we were about to challenge');
});

test('a challenged request is still counted, or the ledger hides what it turned away', () => {
  const src = proxySource();
  const challengeAt = src.indexOf('const dare = await challenge(request)');
  const counted = src.indexOf('countRequest', challengeAt);
  const returned = src.indexOf('return dare', challengeAt);
  assert.ok(counted >= 0 && counted < returned, 'counted before it is returned');
});
