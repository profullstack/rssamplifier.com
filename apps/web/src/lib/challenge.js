/**
 * A question only something running JavaScript can answer.
 *
 * ## Why the rungs below this one do not reach
 *
 * Every limit this site had before is keyed on *who is asking*.
 * `crawlThrottle.js` meters a caller by address and user-agent token;
 * `tiers.js` sorts them onto rungs; the gateway's `chargeSpoofedBrowsers` asks
 * whether a thing claiming Chrome sends the headers Chrome cannot suppress.
 * All three are defeated by the same move, and it is the move the traffic
 * actually makes: ask from somewhere else, every time.
 *
 * Measured on 2026-09-07: 500 requests in 3.5 seconds from **500 distinct
 * addresses**, no address twice, two Chrome user-agent strings between them,
 * and every one of the 500 paths different — 329 distinct topic slugs. A
 * per-caller limit sees five hundred callers with one request each and refuses
 * nobody. A cache is never asked the same question twice and hits nothing. The
 * fleet already sends `Sec-Fetch-Mode`, so the spoof check waves it through
 * (see `rssamplifier-residential-proxy-fleet`). Rotating the address is cheap
 * and there is no rung that charges for it.
 *
 * So this one is keyed on *what the caller can do*. Before an expensive page is
 * rendered, the caller is asked to find a number whose hash starts with a run
 * of zero bits. Verifying the answer is one hash and costs us nothing. Finding
 * it costs the caller a fraction of a second of real CPU, and — this is the
 * part the address rotation cannot help with — it has to be paid **per
 * address**, because the answer is bound to the address that solved it.
 * Rotating through five hundred addresses now means solving five hundred times.
 *
 * ## What it is honestly worth
 *
 * Not a wall. A client that runs a real JavaScript engine can pay this; the
 * fleet may well be headless browsers, in which case what it buys is a tax
 * rather than a refusal, and the tax is one solve per address per hour rather
 * than per request. What it stops outright is the much larger population that
 * replays headers without an engine behind them. Both outcomes are worth
 * having and neither is a victory: `workers.js` makes the same point about
 * capacity, and the two together are a slope, not a gate.
 *
 * ## Who is never asked
 *
 * `crawl-gateway.js` already names the callers who have said who they are — a
 * reader with a session, a program with an API key, a retrieval crawler or
 * search engine on the lists — and `exempt()` is reused here unchanged rather
 * than copied, so the two can never drift into disagreeing about who is
 * welcome. Training crawlers never reach this code: the gate answers them 402
 * first.
 *
 * Three more exclusions, each of which would be a bug rather than a policy:
 *
 *   - **The API is never challenged.** `apiguard.js` carries a written decision
 *     against gating it, and that decision is right: a metered-but-open API can
 *     grow a paid tier by raising a number, and a gated one has already broken
 *     every agent that reads this directory today. A scraper pushed onto
 *     `/api/topics/*` is a scraper reading 5 KB of JSON instead of rendering
 *     47 KB of HTML, which is the trade we want anyway.
 *   - **Feed exports are never challenged.** `.rss`, `.atom`, `.json`, `.opml`,
 *     `.m3u`, `.pls` are what feed readers subscribe to. A challenge there
 *     breaks every subscriber silently and permanently.
 *   - **Only HTML page routes under /topics and /authors, and the reader.**
 *     That was 400 of the 500 requests in the sample. The rest of the site is
 *     cheap enough not to be worth the interruption.
 *
 * ## Off unless switched on
 *
 * `CHALLENGE_ENABLED` defaults to **off**, and without `CHALLENGE_SECRET` it
 * stays off however it is set. This is the one limit on the site that a real
 * reader can *see*, so it does not arrive with a deploy — it arrives when
 * someone decides the traffic is worth interrupting people for, and it leaves
 * again by unsetting one variable.
 *
 * Edge-clean, like `crawl-gateway.js`: Web Crypto only, no `node:` import, and
 * every environment variable read through a non-literal key because Next
 * inlines `process.env.NAME` at build time and the image is built without
 * these values.
 *
 * It answers with a plain `Response` and reads the path off `request.url`
 * rather than reaching for `NextResponse` and `nextUrl`. Next accepts either,
 * and `next/server` has no export map plain Node can resolve — importing it is
 * why proxy.js has to be tested by reading its own source back as text. This
 * module is the one with the arithmetic in it, so it is the one that has to be
 * exercised for real rather than grepped.
 */

import { clientIp } from '@profullstack/x402-gateway/edge';

import { exempt } from './crawl-gateway.js';

const env = process.env;

/** The cookie carrying a solved challenge. */
export const CHALLENGE_COOKIE = 'rsa_pow';

/** How many leading zero bits the hash must have. */
const DEFAULT_BITS = 18;

/** How long one solution is good for. */
const DEFAULT_TTL_MINUTES = 60;

/**
 * The most a solution may be worth, in minutes.
 *
 * A long-lived token is a long-lived pass for whoever solved it once, and the
 * whole cost model here is "per address, per period". Beyond a day the tax
 * rounds to nothing.
 */
const MAX_TTL_MINUTES = 1440;

/**
 * The routes worth interrupting someone for.
 *
 * The three the fleet actually walks. `/read` is matched at the end of any path
 * because the reader lives at `/{slug}/read`, and it is the most expensive
 * thing on the site — see `pageGate.js`.
 */
const EXPENSIVE = /^\/(?:topics|authors)\/|\/read$/;

/**
 * Anything a machine subscribes to, which must never be challenged.
 *
 * Matched on the extension rather than the route because the same topic is
 * served at `/topics/x` and `/topics/x.rss`, and only the first is a page.
 */
const EXPORT_EXTENSION = /\.(?:rss|atom|json|opml|m3u|pls|xml|txt|csv)$/;

/**
 * An integer environment variable inside its bounds, or the fallback.
 *
 * Junk falls back rather than to nothing, for the reason `pageGate.js` gives —
 * except that here "nothing" would mean a difficulty of zero, which is a
 * challenge every caller passes without doing any work at all. A typo must not
 * quietly turn the defence off while leaving the interruption in place.
 *
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function envInt(name, fallback, min, max) {
  const raw = Number(env[name]);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

/** How many leading zero bits an answer must have. @returns {number} */
export function bits() {
  return envInt('CHALLENGE_BITS', DEFAULT_BITS, 1, 32);
}

/** How long a solution stays good, in milliseconds. @returns {number} */
export function ttlMs() {
  return envInt('CHALLENGE_TTL_MINUTES', DEFAULT_TTL_MINUTES, 1, MAX_TTL_MINUTES) * 60_000;
}

/**
 * The signing secret, or empty when there is none.
 *
 * There is deliberately no default. A shared constant would let anyone compute
 * a valid token offline, which is worse than not running this at all: it would
 * cost every real reader a second and cost the fleet nothing.
 *
 * @returns {string}
 */
function secret() {
  return (env['CHALLENGE_SECRET'] ?? '').trim();
}

/**
 * Whether the challenge is switched on.
 *
 * Two conditions, and the secret is the one that cannot be overridden: without
 * it the tokens are forgeable, so being "enabled" would be a costume. Off is
 * the safe direction for a check that stands between readers and the site.
 *
 * @returns {boolean}
 */
export function enabled() {
  return env['CHALLENGE_ENABLED'] === '1' && secret().length > 0;
}

/**
 * Who this challenge is bound to.
 *
 * The address, and the user-agent alongside it so one solved token cannot be
 * handed round a fleet sharing an exit address. Deliberately *not* the path:
 * the reader is meant to solve once and then browse, and a per-path challenge
 * would ask again on every link.
 *
 * The address comes from `clientIp`, which reads `X-Real-IP` and otherwise the
 * LAST `X-Forwarded-For` hop — never the first, which the client writes.
 *
 * @param {Request} request
 * @returns {string}
 */
function subject(request) {
  return `${clientIp(request)}|${request.headers.get('user-agent') ?? ''}`;
}

/** Bytes as lower-case hex. @param {ArrayBuffer} buf @returns {string} */
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The puzzle this caller has to solve at this moment.
 *
 * An HMAC over the subject and the issue time, so the server keeps no state:
 * a token carries the time it was issued, and the seed it was solved against
 * can always be recomputed from that. Nothing is stored, nothing expires from
 * memory, and sixteen workers agree without talking to each other — which
 * matters, because since 2026-09-07 there are sixteen of them.
 *
 * @param {Request} request
 * @param {number} issuedAt
 * @returns {Promise<string>}
 */
export async function seedFor(request, issuedAt) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${subject(request)}|${issuedAt}`),
  );
  return hex(mac);
}

/**
 * Whether a hash opens with `n` zero bits.
 *
 * Bit-wise rather than counting hex characters, so the difficulty is a smooth
 * dial: every extra bit doubles the work, where every extra hex digit would
 * multiply it by sixteen and leave nothing usable between "instant" and
 * "unbearable".
 *
 * @param {Uint8Array} digest
 * @param {number} n
 * @returns {boolean}
 */
export function hasLeadingZeroBits(digest, n) {
  const whole = n >> 3;
  for (let i = 0; i < whole; i += 1) if (digest[i] !== 0) return false;
  const rest = n & 7;
  return rest === 0 || (digest[whole] >> (8 - rest)) === 0;
}

/**
 * Whether this request carries a solution that is this caller's, current, and
 * hard enough.
 *
 * All three have to be checked. Age alone lets a token outlive its cost; the
 * subject alone lets a solved token be passed around; the work alone lets any
 * pair of numbers through. The difficulty is read now rather than taken from
 * the token, so raising `CHALLENGE_BITS` re-challenges everyone rather than
 * honouring answers to an easier question.
 *
 * @param {Request} request
 * @returns {Promise<boolean>}
 */
export async function solved(request) {
  const cookie = request.headers.get('cookie') ?? '';
  const found = /(?:^|;\s*)rsa_pow=([^;]+)/.exec(cookie);
  if (!found) return false;

  const [issued, nonce] = decodeURIComponent(found[1]).split('.');
  const issuedAt = Number(issued);
  if (!Number.isInteger(issuedAt) || !nonce) return false;

  const age = Date.now() - issuedAt;
  if (age < 0 || age > ttlMs()) return false;

  const seed = await seedFor(request, issuedAt);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed + nonce));
  return hasLeadingZeroBits(new Uint8Array(digest), bits());
}

/**
 * Whether this request is one we would interrupt, before asking whether it
 * has already been answered.
 *
 * Order matters for cost: the cheap string tests run before `exempt()` reads
 * headers, and `solved()` — the only part that hashes — runs last and only for
 * a request that would otherwise be refused.
 *
 * @param {Request} request
 * @param {string} pathname
 * @returns {boolean}
 */
export function wouldChallenge(request, pathname) {
  if (!enabled()) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (!EXPENSIVE.test(pathname)) return false;
  if (EXPORT_EXTENSION.test(pathname)) return false;
  if (pathname.startsWith('/api/')) return false;
  return !exempt(request);
}

/**
 * The challenge, or nothing when this caller may pass.
 *
 * Returns a response only when one is owed, so the proxy reads it the same way
 * it reads the gateway: an answer stops the request, silence lets it through.
 *
 * @param {Request} request
 * @returns {Promise<Response | null>}
 */
export async function challenge(request) {
  const url = new URL(request.url);
  if (!wouldChallenge(request, url.pathname)) return null;
  if (await solved(request)) return null;

  const issuedAt = Date.now();
  const seed = await seedFor(request, issuedAt);
  return page(seed, issuedAt, bits(), url.pathname + url.search);
}

/**
 * The interstitial.
 *
 * Served 503 rather than 200, with `Retry-After`, so that anything reading
 * status codes — a monitor, a search crawler that slipped past the lists, a
 * feed reader following a link — treats it as "come back", not as the page. A
 * 200 here would let a crawler index the interstitial as the article.
 *
 * Its own tight Content-Security-Policy rather than the site's: this page loads
 * nothing, so it may as well say so. The site's policy allows inline script for
 * the reason next.config.mjs gives, and this page needs that much and no more.
 *
 * @param {string} seed
 * @param {number} issuedAt
 * @param {number} difficulty
 * @param {string} target
 * @returns {Response}
 */
function page(seed, issuedAt, difficulty, target) {
  return new Response(html(seed, issuedAt, difficulty, target), {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '5',
      'x-robots-tag': 'noindex',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}

/**
 * SHA-256, as the page computes it.
 *
 * Kept as source text rather than written as a function here, because it is
 * shipped to the browser inside the interstitial and there is nowhere else for
 * it to live: the page loads no scripts (its own Content-Security-Policy says
 * `default-src 'none'`, and next.config.mjs would not let it reach a CDN
 * anyway). Exported so that test/challenge.test.js can run this exact text and
 * check it against Web Crypto — a hash that disagreed with the server's by one
 * bit would produce a challenge nobody can ever solve, and the only symptom
 * would be readers stuck on an interstitial forever while the logs said nothing.
 *
 * ## Why not `crypto.subtle.digest`
 *
 * Because it is asynchronous, and a promise per hash costs far more than the
 * hash. Measured end to end against this server: Web Crypto managed about
 * 67,000 hashes a second, so the 18-bit default — 262,000 hashes on average —
 * would have taken a reader **eight seconds**. That difference is the whole
 * design. The difficulty has to be high enough to be a real tax on a fleet
 * solving once per address and low enough that a person barely notices, and
 * with an async hash there is no such number.
 *
 * ## Why the caller owns the padding
 *
 * `sha256Head` takes a buffer that is *already* padded to a whole number of
 * blocks and reads its words straight out of it. The first version of this
 * computed each byte through a function that applied the padding on the fly,
 * which was correct and managed 17,000 hashes a second — slower than the Web
 * Crypto it replaced — because it made a thousand function calls per block.
 * The message only changes in its last few digits between attempts, so the
 * solver writes those in place and rebuilds the padding on the ten occasions
 * the nonce gains a digit.
 *
 * Only the first word of the digest is returned. The difficulty is capped at
 * 32 bits, so nothing past it is ever looked at.
 */
export const SHA256_JS = `
var K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];
var W = new Int32Array(64);

/* The first word of SHA-256(b), where b is already padded to \`blocks\` bytes. */
function sha256Head(b, blocks) {
  var h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
      h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  for (var off = 0; off < blocks; off += 64) {
    for (var i = 0; i < 16; i++) {
      var p = off + (i << 2);
      W[i] = (b[p] << 24) | (b[p+1] << 16) | (b[p+2] << 8) | b[p+3];
    }
    for (i = 16; i < 64; i++) {
      var x = W[i-15], y = W[i-2];
      var s0 = ((x>>>7)|(x<<25)) ^ ((x>>>18)|(x<<14)) ^ (x>>>3);
      var s1 = ((y>>>17)|(y<<15)) ^ ((y>>>19)|(y<<13)) ^ (y>>>10);
      W[i] = (((W[i-16] + s0) | 0) + ((W[i-7] + s1) | 0)) | 0;
    }
    var a=h0,b0=h1,c0=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (i = 0; i < 64; i++) {
      var S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
      var t1 = (((((h + S1) | 0) + (((e & f) ^ (~e & g)) | 0)) | 0) + ((K[i] + W[i]) | 0)) | 0;
      var S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
      var t2 = (S0 + (((a & b0) ^ (a & c0) ^ (b0 & c0)) | 0)) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c0; c0=b0; b0=a; a=(t1+t2)|0;
    }
    h0=(h0+a)|0; h1=(h1+b0)|0; h2=(h2+c0)|0; h3=(h3+d)|0;
    h4=(h4+e)|0; h5=(h5+f)|0; h6=(h6+g)|0; h7=(h7+h)|0;
  }
  return h0 >>> 0;
}

/* A buffer holding "<seed><nonce>" padded for SHA-256, rebuilt only when the
   nonce gains a digit and its length changes. */
function padded(seedBytes, digits) {
  var len = seedBytes.length + digits;
  var blocks = (((len + 8) >> 6) + 1) << 6;
  var b = new Uint8Array(blocks);
  b.set(seedBytes);
  b[len] = 0x80;
  var bits = len * 8;
  b[blocks-4] = (bits >>> 24) & 0xff;
  b[blocks-3] = (bits >>> 16) & 0xff;
  b[blocks-2] = (bits >>> 8) & 0xff;
  b[blocks-1] = bits & 0xff;
  return { buf: b, blocks: blocks };
}
`;

/**
 * The page's markup, and the loop that solves the challenge.
 *
 * The loop runs synchronously in bursts of about sixty milliseconds and yields
 * between them, so the tab stays responsive and the progress bar moves. It is
 * not trying to be unnoticeable — the reader is told what is happening and why
 * — but a solver that froze the page would read as a broken site rather than as
 * a wait.
 *
 * Both escape hatches are named in the markup, because a page that interrupts
 * someone owes them a way past that does not depend on the thing being
 * interrupted. A person signs in — the session exempts them from then on. A
 * program that cannot run this is told where the open endpoints are, which is
 * the same answer the 429 gives.
 *
 * @param {string} seed
 * @param {number} issuedAt
 * @param {number} difficulty
 * @param {string} target
 * @returns {string}
 */
function html(seed, issuedAt, difficulty, target) {
  const json = JSON.stringify({ seed, issuedAt, difficulty, target }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>One moment · RSS Amplifier</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #fbfbf9; color: #1a1a18; padding: 2rem; }
@media (prefers-color-scheme: dark) { body { background: #14140f; color: #e8e6df; } }
main { max-width: 34rem; }
h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
p { margin: 0 0 .85rem; }
.muted { opacity: .7; font-size: .9rem; }
a { color: inherit; }
progress { width: 100%; height: .4rem; margin: .5rem 0 1rem; }
</style>
</head>
<body>
<main>
<h1>One moment</h1>
<p id="status">Checking your browser…</p>
<progress id="bar" max="100" value="0"></progress>
<p class="muted">The directory is being scraped hard right now, so a page costs
a moment of your computer's time before it loads. This happens about once an
hour, not once a page. Nothing about you is stored beyond the answer.</p>
<p class="muted"><a href="/login">Sign in</a> and you will not be asked again.
If you are a program: <a href="/llms.txt">/llms.txt</a>,
<a href="/api/feeds">/api/feeds</a>, <a href="/opml">/opml</a> and
<a href="/mcp">/mcp</a> are open and never challenged.</p>
<noscript><p><strong>This needs JavaScript.</strong> Without it, use
<a href="/llms.txt">/llms.txt</a>, <a href="/api/feeds">/api/feeds</a> or
<a href="/opml">/opml</a>, which are open to everyone.</p></noscript>
</main>
<script>
(function () {
  var c = ${json};
  var status = document.getElementById('status');
  var bar = document.getElementById('bar');
${SHA256_JS}

  var seedBytes = new TextEncoder().encode(c.seed);
  var digits = 1;
  var page = padded(seedBytes, digits);
  var nonce = 0;
  var expected = Math.pow(2, c.difficulty);
  var shift = 32 - c.difficulty;

  function digitsOf(n) {
    var d = 1;
    while (n >= 10) { n = (n / 10) | 0; d++; }
    return d;
  }

  function batch() {
    var deadline = Date.now() + 60;
    do {
      for (var i = 0; i < 5000; i++) {
        var d = digitsOf(nonce);
        if (d !== digits) { digits = d; page = padded(seedBytes, digits); }

        var n = nonce;
        var at = seedBytes.length + d;
        while (at > seedBytes.length) { page.buf[--at] = 48 + (n % 10); n = (n / 10) | 0; }

        if ((sha256Head(page.buf, page.blocks) >>> shift) === 0) return done(nonce);
        nonce++;
      }
    } while (Date.now() < deadline);

    bar.value = Math.min(99, (nonce / expected) * 100);
    setTimeout(batch, 0);
  }

  function done(n) {
    bar.value = 100;
    status.textContent = 'Done. Loading the page…';
    document.cookie = 'rsa_pow=' + encodeURIComponent(c.issuedAt + '.' + n) +
      '; path=/; max-age=86400; samesite=lax';
    location.replace(c.target);
  }

  batch();
})();
</script>
</body>
</html>
`;
}
