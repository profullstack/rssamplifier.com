import { NextResponse } from 'next/server';

import { SIGNED_IN_HINT_COOKIE, hintToRestore } from './lib/session-hint.js';

/**
 * Put the signed-in hint back when a session has one and the hint has gone.
 *
 * All of the reasoning is in lib/session-hint.js, which knows nothing about
 * Next and can therefore be tested directly. This is the part that cannot: one
 * response, one cookie on it.
 *
 * @param {import('next/server').NextRequest} request
 */
export function proxy(request) {
  const response = NextResponse.next();

  const options = hintToRestore(request);
  if (options) response.cookies.set(SIGNED_IN_HINT_COOKIE, '1', options);

  return response;
}

/**
 * Which requests are worth the look.
 *
 * Everything except the build's own static output, the files served straight
 * from /public, the feeds, and the endpoints where a hint would be pointless:
 * /api answers machines, and the sign-in route sets both cookies itself a
 * moment later.
 *
 * A document request is cheap to add a header to and is the only kind that
 * renders a masthead — matching /_next/static as well would put this in front
 * of every image and chunk on the page for nothing.
 *
 * The pattern has to be written here as a literal: Next parses this object at
 * build time and rejects a matcher it cannot read off the page, so it cannot be
 * imported from lib beside the rest of the logic. test/proxy.test.js reads it
 * back out of this file rather than keeping a second copy to drift from.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|api/|auth/magic|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|txt|xml|rss|atom|opml|m3u|pls|json)$).*)',
  ],
};
