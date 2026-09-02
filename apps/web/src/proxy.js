import { NextResponse } from 'next/server';

import { SIGNED_IN_HINT_COOKIE, hintToRestore } from './lib/session-hint.js';
import { attempt, callerIdentity } from './lib/crawlThrottle.js';
import { countRequest } from './lib/trafficCounter.js';
import { tierFor } from './lib/tiers.js';

/**
 * The one thing that runs in front of every request.
 *
 * Three jobs, and they want different surfaces, which is the only reason this
 * file is more than it was:
 *
 *   1. Shape crawl traffic. Reasoning in lib/crawlThrottle.js. This wants to
 *      see *everything* an expensive caller can ask for — the API, the feed
 *      files, the framing proxy — because those are where the load actually is.
 *   2. Put the signed-in hint back. Reasoning in lib/session-hint.js. This only
 *      makes sense on a request that renders a masthead, which is a much
 *      narrower set.
 *   3. Count what asked for what. Reasoning in lib/traffic.js. Same surface as
 *      the throttle, for the same reason — and it runs *before* the throttle
 *      decides, so a refused request is still counted. A limit that hides the
 *      traffic it is turning away cannot be tuned against anything.
 *
 * Next parses one `config.matcher` per file at build time, so the matcher is
 * sized for the wider job and the narrower one is gated in code by
 * `WANTS_MASTHEAD` below. The alternative — a second interceptor — is not
 * available: Next 16 allows exactly one proxy file per app.
 *
 * @param {import('next/server').NextRequest} request
 */
export function proxy(request) {
  /*
   * Which allowance this caller gets: free, signed-in, or sponsor. Reasoning
   * for all three, and for why the decision is made without a database, is in
   * lib/tiers.js.
   *
   * Note what changed here: a signed-in reader used to skip metering entirely.
   * That was defensible while a session was the only thing above anonymous, and
   * it stops being defensible the moment signing in is a *tier* — an unmetered
   * rung means the ladder tops out at "make an account", which is free and
   * unlimited, and nothing above it can be worth paying for. Signed in is now
   * a large budget rather than no budget.
   */
  const tier = tierFor(request);

  // Never allowed to fail: see `countRequest`. Runs before the verdict so a
  // refused request is still counted, and carries the tier so the rollup can
  // say which allowance the traffic arrived under.
  countRequest(request, tier.name);

  const verdict = attempt(callerIdentity(request), Date.now(), tier);
  if (!verdict.ok) return tooMany(verdict, tier);

  const response = NextResponse.next();

  if (WANTS_MASTHEAD.test(request.nextUrl.pathname)) {
    const options = hintToRestore(request);
    if (options) response.cookies.set(SIGNED_IN_HINT_COOKIE, '1', options);
  }

  return response;
}

/**
 * The refusal.
 *
 * Says which rung the caller is on and what the next one costs, because a 429
 * that only says "slow down" leaves a caller with nothing to do but retry —
 * and the whole point of a ladder is that there is somewhere to go. The upgrade
 * path is spelled out rather than linked alone: an agent reading this is
 * exactly the reader who can act on it without a human.
 *
 * @param {{ retryAfter: number }} verdict
 * @param {{ name: string, burst: number, hourly: number }} tier
 * @returns {NextResponse}
 */
function tooMany(verdict, tier) {
  const nextRung =
    tier.name === 'anon'
      ? 'Sign in for ten times this allowance — free, magic link, no card: https://rssamplifier.com/login'
      : tier.name === 'session'
        ? 'Create an API key at https://rssamplifier.com/account and send it as a bearer token; a sponsored key raises the ceiling further.'
        : 'This is the sponsor ceiling. If you need more than this, ask and we will raise it.';

  return NextResponse.json(
    {
      error: 'rate limit exceeded',
      // Said plainly, because the alternative is that they guess and retry. The
      // directory is still open to them; this is a speed limit, not a door.
      hint: 'You are welcome here, just slower. Cheaper entry points: https://rssamplifier.com/llms.txt, /api/feeds, /opml, /mcp',
      tier: tier.name,
      hourlyLimit: Number.isFinite(tier.hourly) ? tier.hourly : null,
      upgrade: nextRung,
      retryAfter: verdict.retryAfter,
    },
    {
      status: 429,
      headers: {
        'retry-after': String(verdict.retryAfter),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'x-ratelimit-tier': tier.name,
        'x-ratelimit-limit': String(tier.burst),
        'x-ratelimit-limit-hour': Number.isFinite(tier.hourly) ? String(tier.hourly) : 'unlimited',
        'x-ratelimit-remaining': '0',
      },
    },
  );
}

/**
 * Which requests render a masthead, and so can have a stale hint to repair.
 *
 * This is the matcher this file used to carry, moved into code unchanged: the
 * build's own static output, the files served straight from /public, the feeds,
 * and the endpoints where a hint would be pointless — /api answers machines,
 * and the sign-in route sets both cookies itself a moment later.
 *
 * It has to live here rather than in lib beside `hintToRestore` for the same
 * reason the matcher does: test/proxy.test.js reads both patterns back out of
 * this file, so that a second copy cannot go on passing after the real one is
 * edited.
 */
const WANTS_MASTHEAD =
  /^\/(?!_next\/static|_next\/image|api\/|auth\/magic|favicon\.ico|robots\.txt|sitemap\.xml|.*\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|txt|xml|rss|atom|opml|m3u|pls|json)$).*$/;

/**
 * Which requests are worth the look.
 *
 * Sized for the throttle, which is the wider of the two jobs: everything except
 * what is too cheap to be worth counting. Those exclusions are not decoration —
 * a person loading one page also pulls the service worker, the manifest and
 * several icons, so metering them would charge a reader half a dozen requests
 * for one page view and push real browsing towards a limit meant for crawlers.
 * `_next/static` is immutable build output and never reaches the app at all.
 *
 * The pattern has to be written here as a literal: Next parses this object at
 * build time and rejects a matcher it cannot read off the page.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|icons/|favicon.ico|manifest.webmanifest|sw.js|robots.txt).*)',
  ],
};
