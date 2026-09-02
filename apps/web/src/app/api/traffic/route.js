import { traffic } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';
import { guard } from '../../../lib/apiguard.js';

export const dynamic = 'force-dynamic';

/**
 * What has been asking, and for what, by the hour.
 *
 * The input to the tiering decision. `byAgent` says who a limit would bind --
 * whether the volume is the AI crawlers robots.txt invites, the SEO scrapers
 * that take and never send, or people. `byBucket` says what it costs: a reader
 * hit fetches and extracts somebody else's page and may pay for a translation,
 * so it is worth orders of magnitude more than a directory page and a flat
 * per-request ceiling prices the two the same.
 *
 * Open, like the rest of the API, and metered by the same guard. There is
 * nothing here that identifies a caller -- the counters hold a user-agent
 * *family* and a route kind, never an address, a session or a raw UA string --
 * and a directory that argues for being the legible, machine-readable copy of
 * the independent web is poorly placed to keep its own numbers private.
 *
 * `?hours=` selects the window, default 24, capped at 30 days by the query.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const allowed = await guard(req);
  if (!allowed.ok) return allowed.response;

  const url = new URL(req.url);
  const hours = Number(url.searchParams.get('hours') ?? 24) || 24;

  const summary = await traffic.trafficSummary(db(), hours);

  return new Response(JSON.stringify(summary, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short, but not zero: this is a rollup that moves once a minute, and it
      // is exactly the sort of endpoint a dashboard would poll in a loop.
      'cache-control': 'public, max-age=60',
      ...allowed.headers,
    },
  });
}
