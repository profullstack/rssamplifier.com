import { createGateway, isTrainingAgent, RETRIEVAL_AGENTS } from '@profullstack/x402-gateway';
import { x402Proxy } from '@profullstack/x402-gateway/next';

import { SIGNED_IN_HINT_COOKIE } from './session-hint.js';

/**
 * The crawl gateway: training crawlers pay, everyone else reads free.
 *
 * This directory used to welcome every AI crawler by name in robots.txt, on
 * purpose — being the open, machine-readable copy of the independent web was
 * the whole point. The bill for that arrived in a Railway log sample: ClaudeBot
 * alone was 54% of upstream compute and meta-externalagent another 11%, none of
 * it sending a reader back. So the policy is now split down the line the
 * crawlers' own operators draw:
 *
 *   - Retrieval crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot,
 *     Googlebot, Bingbot…) feed a live index that cites us. Untouched.
 *   - Training crawlers (GPTBot, ClaudeBot, CCBot, meta-externalagent,
 *     Bytespider, Applebot-Extended…) copy pages into a corpus. They get
 *     `402 Payment Required` with an x402 offer — a dollar buys a day, settled
 *     in USDC by CoinPay — or the sales page at /crawl if they asked for HTML.
 *     A paid pass in `x-crawl-pass` opens the site for the day.
 *   - People are never in the picture: matching is on the self-declared
 *     crawler token, and a browser user agent walks straight past.
 *
 * The structured entry points stay open to everyone, training crawlers
 * included, via `openPaths`: they are the cheap alternative to crawling every
 * page, which is what we would rather they did anyway. robots.txt cannot say
 * this for the training groups — its grammar for them is `Disallow: /` plus
 * `Allow: /crawl` — so it is enforced here, at request time, and documented in
 * the comment block at the top of robots.txt.
 *
 * Kept in its own module so the proxy and the robots route are generated from
 * ONE set of lists. Nothing here may import a Node-only module: the package is
 * edge-safe (Web Crypto, no `node:`), and lib/db.js — where the app's
 * `siteUrl()` lives — is not, because it imports the libSQL client. So the
 * origin is read straight from the same variable, with the same default.
 *
 * Every variable is read through a non-literal key on purpose: Next inlines
 * `process.env.NAME` at build time, and the Docker image is built without the
 * CoinPay key or the payout address. A literal read would bake `undefined` in
 * and Railway's runtime values would never be seen.
 */

const env = process.env;

/** `SITE_URL` without a trailing slash, as lib/db.js reads it. */
function siteUrl() {
  return (env['SITE_URL'] || 'https://rssamplifier.com').replace(/\/+$/, '');
}

/**
 * Paths a refused crawler may still read.
 *
 * /robots.txt, /crawl, /security.txt and /.well-known/ are always open; these
 * are ours. /mcp is the endpoint at its short address (the proxy sees the URL
 * before the rewrite to /api/mcp) and at its long one, so a client that read
 * the API docs is not charged for calling the same thing by its other name.
 */
export const OPEN_PATHS = ['/llms.txt', '/skill.md', '/opml', '/mcp', '/api/mcp', '/api/feeds'];

/**
 * Addresses that serve no readers: the OVH VPS fleet.
 *
 * Measured 2026-08-28 in the edge logs — vps-*.vps.ovh.net, every request
 * wearing a spoofed "Chrome/148" and walking the directory at a rate no
 * person browses at. The /16s the fleet came from, answered 403 before any
 * other check runs, with a body small enough that refusing costs nothing. A
 * hosting range is not where a reader lives, and whoever runs the fleet has
 * already declined to say who they are, so there is no pass on sale either.
 */
export const DENY_CIDRS = [
  '51.38.0.0/16',
  '54.38.0.0/16',
  '141.94.0.0/16',
  '145.239.0.0/16',
  '149.202.0.0/16',
  '151.80.0.0/16',
  '57.129.0.0/16',
  '213.32.0.0/16',
];

/**
 * Search engines, welcome by name.
 *
 * Kept apart from the gateway's retrieval list because these are the classic
 * indexers rather than the AI-answer half of a training pair. Named here
 * because the spoof check below asks "is this the browser it claims to be?",
 * and Googlebot's evergreen user agent claims Chrome (its rendering engine)
 * without sending a browser's fetch-metadata headers. A crawler that names
 * itself is not spoofing anything; it is answered by the lists, not the check.
 */
const SEARCH_ENGINES = ['Googlebot', 'Bingbot', 'Applebot', 'DuckDuckBot', 'YandexBot'];

/** The shape of one of our API keys — `rsa_<8 hex>_<secret>`, see @rssamplifier/auth. */
const API_KEY_SHAPE = /^rsa_[0-9a-f]{8}_[\w-]{20,}$/;

/**
 * Whether the request carries something shaped like one of our API keys, in
 * either place @rssamplifier/auth reads it from.
 *
 * The shape only: verifying the key is a database lookup, which lib/tiers.js
 * does a moment later to place the caller on a rung, and this module has to
 * stay edge-clean (@rssamplifier/auth imports node:crypto). A caller who sends
 * a made-up key gets past the gate and lands in the anonymous tier, metered
 * like everyone else — which is where a curl user agent lands too, so nothing
 * is given away that the throttle was not already the guard for.
 *
 * @param {Request} request
 */
function carriesApiKey(request) {
  const auth = request.headers.get('authorization') ?? '';
  const bearer = /^bearer\s+(\S+)$/i.exec(auth.trim());
  const token = bearer ? bearer[1] : (request.headers.get('x-api-key') ?? '').trim();
  return API_KEY_SHAPE.test(token);
}

/**
 * Who is never charged, whatever they look like.
 *
 * Three kinds of caller have already said who they are: a reader with a
 * session (the `signed_in` hint the masthead reads, or the session cookie it
 * describes), a program with an API key, and a crawler that names itself on
 * the retrieval or search-engine lists. None of them is what the spoof check
 * is for — that check exists for the caller that says nothing true about
 * itself — so they step around it. A training crawler that also matches a
 * welcomed token (Applebot-Extended contains "Applebot") is a training
 * crawler first.
 *
 * @param {Request} request
 * @returns {boolean}
 */
export function exempt(request) {
  const cookie = request.headers.get('cookie') ?? '';
  if (cookie.includes(`${SIGNED_IN_HINT_COOKIE}=`) || /(^|;\s*)rsa_session=[^;]/.test(cookie)) return true;
  if (carriesApiKey(request)) return true;

  const ua = request.headers.get('user-agent') ?? '';
  if (isTrainingAgent(ua)) return false;
  return isTrainingAgent(ua, RETRIEVAL_AGENTS) || isTrainingAgent(ua, SEARCH_ENGINES);
}

export const gateway = createGateway({
  siteUrl: siteUrl(),
  siteName: 'RSS Amplifier',
  coinpay: { apiKey: env['COINPAY_X402_KEY'] },
  payTo: env['CRAWL_PAY_TO'],
  openPaths: OPEN_PATHS,
  denyCidrs: DENY_CIDRS,
  /*
   * A request that says "Chrome/…" and does not send Sec-Fetch-Mode is an
   * HTTP client with a copied string: every Chromium since 76 sends the
   * header on every request and, being a forbidden header, nothing in a page
   * can remove it. Switched on because of what the edge logs showed on
   * 2026-09-05: a residential-proxy rotation — 499 distinct addresses in 500
   * requests, never more than two hits from one, cycling three generic Chrome
   * strings (Chrome/142 and Chrome/144 on Windows, Chrome/145 on a Mac) —
   * walking /topics/*, /api/topics/* and /authors/* at 25 to 250 requests a
   * second, with 78% of a burst shed by server.mjs's in-flight cap. A CIDR
   * list cannot touch that; a question only a browser can answer can. It is
   * charged like GPTBot: 402 and the offer, a hash instead of a render.
   */
  chargeSpoofedBrowsers: true,
  exempt,
});

/**
 * The gate, in the shape the proxy composes with: resolves to a Response to
 * send, or `undefined` to carry on.
 *
 * @type {(request: Request) => Promise<Response | undefined>}
 */
export const gate = x402Proxy(gateway);
