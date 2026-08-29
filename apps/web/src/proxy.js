import { NextResponse } from 'next/server';

import { SIGNED_IN_HINT_COOKIE, hintToRestore } from './lib/session-hint.js';
import { attempt, callerIdentity, LIMITS } from './lib/crawlThrottle.js';

/**
 * The one thing that runs in front of every request.
 *
 * Two jobs, and they want different surfaces, which is the only reason this
 * file is more than it was:
 *
 *   1. Shape crawl traffic. Reasoning in lib/crawlThrottle.js. This wants to
 *      see *everything* an expensive caller can ask for — the API, the feed
 *      files, the framing proxy — because those are where the load actually is.
 *   2. Put the signed-in hint back. Reasoning in lib/session-hint.js. This only
 *      makes sense on a request that renders a masthead, which is a much
 *      narrower set.
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
   * A signed-in reader is a person, and people are never metered.
   *
   * Cookie presence only — no lookup, no database, no validation. A forged
   * cookie buys nothing but an unmetered request, which is what every signed
   * out reader already gets below the allowance anyway; checking it properly
   * would mean a session query in front of every page in the directory, which
   * is exactly the cost the throttle exists to contain.
   */
  const signedIn = Boolean(request.cookies.get('rsa_session')?.value);

  if (!signedIn) {
    const verdict = attempt(callerIdentity(request));
    if (!verdict.ok) return tooMany(verdict);
  }

  const response = NextResponse.next();

  if (WANTS_MASTHEAD.test(request.nextUrl.pathname)) {
    const options = hintToRestore(request);
    if (options) response.cookies.set(SIGNED_IN_HINT_COOKIE, '1', options);
  }

  return response;
}

/**
 * @param {{ retryAfter: number }} verdict
 * @returns {NextResponse}
 */
function tooMany(verdict) {
  return NextResponse.json(
    {
      error: 'rate limit exceeded',
      // Said plainly, because the alternative is that they guess and retry. The
      // directory is still open to them; this is a speed limit, not a door.
      hint: 'You are welcome here, just slower. Cheaper entry points: https://rssamplifier.com/llms.txt, /api/feeds, /opml, /mcp',
      retryAfter: verdict.retryAfter,
    },
    {
      status: 429,
      headers: {
        'retry-after': String(verdict.retryAfter),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'x-ratelimit-limit': String(LIMITS.FREE_PER_WINDOW),
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
