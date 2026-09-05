import { createGateway } from '@profullstack/x402-gateway';
import { x402Proxy } from '@profullstack/x402-gateway/next';

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

export const gateway = createGateway({
  siteUrl: siteUrl(),
  siteName: 'RSS Amplifier',
  coinpay: { apiKey: env['COINPAY_X402_KEY'] },
  payTo: env['CRAWL_PAY_TO'],
  openPaths: OPEN_PATHS,
});

/**
 * The gate, in the shape the proxy composes with: resolves to a Response to
 * send, or `undefined` to carry on.
 *
 * @type {(request: Request) => Promise<Response | undefined>}
 */
export const gate = x402Proxy(gateway);
