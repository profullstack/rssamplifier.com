import { createGateway, isTrainingAgent, readPass } from '@profullstack/x402-gateway';
import { crawlSales } from '@rssamplifier/db';

import { db } from './db.js';
import { splitSale } from './partners.js';
import { classifyAgent } from './traffic.js';
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
export const OPEN_PATHS = [
  '/llms.txt',
  '/skill.md',
  '/opml',
  '/mcp',
  '/api/mcp',
  '/api/feeds',
  // The board is open on purpose, and both spellings are needed: the gateway
  // prefix-matches only entries ending in a slash, so '/leaderboard' alone
  // would open the index and still charge for every board on it. An agent that
  // hits a 402 on the page ranking its own spend cannot read the case for
  // buying a pass.
  '/leaderboard',
  '/leaderboard/',
  // The pitch is how a publisher finds out they can be paid for what a crawler
  // is already taking. Charging the crawler to read our own recruiting page
  // would be an odd way to run a marketplace.
  '/sell',
  '/sell/',
];

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
 * Search engines welcome by name alone: only the ones whose operator publishes
 * no address list the gateway can check.
 *
 * Googlebot, bingbot, Applebot and DuckDuckBot used to be here too, and that
 * made them a costume: any scraper wearing "Googlebot" stepped around the gate
 * entirely. Since gateway 0.10 they are judged by name AND published address
 * (`gateway.isWelcome`), welcome from their ranges and charged as impostors
 * from anywhere else. The same call covers the retrieval crawlers and AI chat
 * fetchers (ChatGPT-User, Claude-User, Perplexity-User, meta-externalfetcher,
 * meta-webindexer, YouBot...), which Anthony asked to keep welcome on
 * 2026-10-19.
 */
const NAME_ONLY_SEARCH_ENGINES = ['YandexBot'];

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
  // `gateway` is defined below; exempt() only ever runs at request time.
  return gateway.isWelcome(request) || isTrainingAgent(ua, NAME_ONLY_SEARCH_ENGINES);
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
  /*
   * gateway 0.16 gives a suspect string 20 pages an hour per address before
   * the 402. Not here, not everywhere: the rotation above never sent more
   * than two requests from one address, so a per-address allowance would hand
   * it the whole directory. Only the front door gets it, so a person or an
   * agent fetching the homepage once reads it (2026-10-28: a one-shot fetch
   * of the homepage got 402) while /topics, /authors and the API stay charged
   * on sight. '/' alone is the homepage, not a prefix.
   */
  suspectAllowance: { requests: 20, windowSeconds: 3600, paths: ['/', '/about', '/contact', '/advertise', '/submit', '/terms', '/privacy'] },
  exempt,
  /*
   * What a pass actually buys, printed on the sales page and in every 402.
   *
   * Every line is rate, and that is not a hedge — it is the directory's whole
   * position, argued in lib/tiers.js: the data stays open to everyone, no key,
   * no account, no field withheld, and money buys speed. A benefits list that
   * promised fields or endpoints the free tier cannot have would be selling the
   * opposite of what this site is for, and would cost us the search and AI
   * answer traffic that is the only way a person finds us.
   *
   * Written as the numbers rather than as adjectives, because the reader is
   * deciding between paying, waiting, and rotating addresses, and only the
   * numbers settle that.
   */
  benefits: [
    '120,000 requests an hour, up from 600 anonymous or 6,000 signed in',
    '2,000 requests a minute of burst, up from 120',
    'No throttle on any page, feed, or API route, for the whole day',
    'Every field and every entry point stays open to everyone, paid or not: a pass buys rate, never access',
  ],
  /*
   * Book the sale.
   *
   * traffic_hourly has counted who asks and who is refused since 2026-09-02,
   * and said nothing about who paid: a pass existed only for as long as the
   * response took to send. The promise is returned rather than dropped
   * because the gateway awaits this hook before the receipt goes out, which
   * is what makes the row land before the buyer is told it worked. A
   * rejection is swallowed there, so a database failure still sells the pass
   * it was paid for.
   */
  onSale: (sale) =>
    crawlSales
      .recordCrawlSale(db(), {
        payer: sale.payer,
        ref: sale.ref,
        days: sale.days,
        priceCents: sale.priceCents,
        totalCents: sale.totalCents,
        currency: sale.currency,
        userAgent: sale.userAgent,
        // The same vocabulary traffic_hourly keys on, so a family reads the
        // same on both sides of the board.
        agent: classifyAgent(sale.userAgent),
        expiresAt: sale.expiresAt,
      })
      .then(() =>
        // Pay the publishers whose blogs were in the crawl. After the sale is
        // booked, and never able to fail it: the money has already moved, and
        // a split we can retry beats a 500 to a paying customer.
        splitSale(sale).catch((err) => console.error('[partners] could not split the sale', err)),
      )
      .catch((err) => console.error('[x402] could not record the sale', err)),
});

/**
 * The gate, in the shape the proxy composes with: resolves to a Response to
 * send, or `undefined` to carry on.
 *
 * @type {(request: Request) => Promise<Response | undefined>}
 */
export const gate = x402Proxy(gateway);

/** Where a pass is presented: the named header, or a bearer token. */
const PASS_HEADER = 'x-crawl-pass';
const BEARER_PASS = /^Bearer\s+(cp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/**
 * Whether this request carries a crawl pass that is genuinely ours and still
 * live.
 *
 * The gate already reads the pass, and answers `undefined` for a holder exactly
 * as it does for a person — which is correct for deciding whether to charge,
 * and loses the one fact the throttle needs: that this caller has paid. Rather
 * than have the gate report it, which would grow a contract five other sites
 * depend on, the pass is read again here. It is an HMAC over a short string
 * with no database behind it, so reading it twice costs a hash.
 *
 * The secret is the CoinPay key, which is what `createGateway` defaults to when
 * no explicit `secret` is passed, so this verifies exactly the tokens the
 * gateway mints and nothing else. With no key configured there are no valid
 * passes to find, and every caller falls through to the free ladder.
 *
 * @param {Request} request
 * @returns {Promise<boolean>}
 */
export async function hasValidPass(request) {
  const secret = env['COINPAY_X402_KEY'];
  if (!secret) return false;

  const direct = request.headers.get(PASS_HEADER);
  const bearer = BEARER_PASS.exec(request.headers.get('authorization') ?? '');
  const token = direct ? direct.trim() : bearer ? bearer[1] : null;
  if (!token) return false;

  try {
    return Boolean(await readPass(token, { secret }));
  } catch {
    // A malformed token is not an error worth failing a request over; it is
    // simply not a pass, and the caller lands on the free ladder.
    return false;
  }
}
