import { NextResponse } from 'next/server';

import { SIGNED_IN_HINT_COOKIE, hintToRestore } from './lib/session-hint.js';
import { challenge } from './lib/challenge.js';
import { gate, hasValidPass } from './lib/crawl-gateway.js';
import { attempt, callerIdentity } from './lib/crawlThrottle.js';
import { countRequest } from './lib/trafficCounter.js';
import { TIERS, tierFor } from './lib/tiers.js';

/**
 * The one thing that runs in front of every request.
 *
 * Five jobs, and they want different surfaces, which is the only reason this
 * file is more than it was:
 *
 *   0. Charge training crawlers. Reasoning in lib/crawl-gateway.js. First,
 *      before anything is metered, because a crawler that is answered 402 has
 *      been given nothing and should not be spending its free allowance on it —
 *      and because the sales page at /crawl is answered here for everyone,
 *      whatever they wear. Same surface as the throttle: the pages and feeds
 *      are what a corpus crawl is after.
 *   0.5. Ask a caller with no name to do some arithmetic. Reasoning in
 *      lib/challenge.js, and it is off unless CHALLENGE_ENABLED and
 *      CHALLENGE_SECRET are both set. After the gate, because a training
 *      crawler is owed a 402 and an offer rather than a puzzle, and before the
 *      throttle, because the whole point is that the throttle cannot see this
 *      traffic: it arrives one request per address.
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
export async function proxy(request) {
  /*
   * The gate answers with a 402, the sales page or a freshly minted pass, or
   * with nothing at all — which is every person, every search crawler, every
   * training crawler on an open path or carrying a pass. Only an answer stops
   * here. It is still counted, as a refusal, for the same reason a 429 is: the
   * ledger has to show what was turned away or the price cannot be judged
   * against anything.
   */
  const answer = await gate(request);
  if (answer) {
    countRequest(request, tierFor(request).name, true);
    return answer;
  }

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
  /*
   * A bought pass is the top rung, and it is checked before the rest of the
   * ladder because it is the only one someone paid for. Without this the pass
   * we sell at /crawl bought a crawler past the 402 and then met the same
   * 600-an-hour throttle as an anonymous curl, which is to say it bought
   * nothing anyone could feel.
   *
   * The gate above has already read the same token and said nothing about it,
   * because "should this be charged" and "what allowance is this" are different
   * questions. Reading it again is one HMAC, and only for a request that
   * actually presents a token.
   */
  /*
   * The arithmetic. Answers only a caller that is anonymous, asking for one of
   * the three expensive page routes, and has not already solved one this hour;
   * everyone else falls straight through, and with the feature off this is a
   * single string comparison. Counted as a refusal for the same reason the gate
   * and the 429 are: a limit that hides what it turned away cannot be tuned.
   */
  const dare = await challenge(request);
  if (dare) {
    countRequest(request, tierFor(request).name, true);
    return dare;
  }

  const tier = (await hasValidPass(request)) ? TIERS.pass : tierFor(request);

  const verdict = attempt(callerIdentity(request), Date.now(), tier);

  /*
   * Never allowed to fail: see `countRequest`.
   *
   * After the verdict rather than before it, which is a change worth naming.
   * The counter used to run first so that a refused request was still counted;
   * it now runs second and counts the *outcome*, which keeps that property and
   * adds the one number the tiering could not otherwise see — how much we are
   * turning away, and from whom. A limit quietly refusing real readers looks
   * exactly like a limit that is working, right up until someone complains.
   */
  countRequest(request, tier.name, !verdict.ok);

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

  /*
   * The rung a program can climb on its own.
   *
   * Every branch above ends at something only a person can do: read an email,
   * fill in a form, ask us. An agent that hits this wall at three in the
   * morning has nowhere to go, and the honest options left to it are to slow
   * down or to spread itself over a proxy pool. So the pass is named here, with
   * its price, as the one upgrade that needs no human on either side.
   *
   * Said to the paid tier too, where it reads as "you already have this",
   * because a caller at the sponsor ceiling asking what is above it should be
   * told there is nothing rather than sold something twice.
   */
  const buyable =
    tier.name === 'pass' || tier.name === 'sponsor'
      ? undefined
      : {
          url: 'https://rssamplifier.com/crawl',
          price: '1.00 USD per day, USDC, settled by CoinPay',
          buys: '120,000 requests an hour and 2,000 a minute, for the whole day',
          how: 'Fetch https://rssamplifier.com/crawl with Accept: application/json for an x402 offer, pay it, then send the pass in the x-crawl-pass header. No account and no human needed.',
        };

  return NextResponse.json(
    {
      error: 'rate limit exceeded',
      // Said plainly, because the alternative is that they guess and retry. The
      // directory is still open to them; this is a speed limit, not a door.
      hint: 'You are welcome here, just slower. Cheaper entry points: https://rssamplifier.com/llms.txt, /api/feeds, /opml, /mcp',
      tier: tier.name,
      hourlyLimit: Number.isFinite(tier.hourly) ? tier.hourly : null,
      upgrade: nextRung,
      ...(buyable ? { buy: buyable } : {}),
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
