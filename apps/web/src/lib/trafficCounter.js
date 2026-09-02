import { traffic } from '@rssamplifier/db';

import { db } from './db.js';
import { classifyAgent, classifyPath, record, startFlushing } from './traffic.js';

/**
 * The wiring between the proxy and the counter.
 *
 * Kept apart from lib/traffic.js so that file stays pure — it classifies and
 * counts and knows nothing about Next, a request object or a database, which is
 * what makes the classifier testable without standing any of that up. This file
 * is the only place the three meet.
 */

let started = false;

/**
 * Count one request, and never fail doing it.
 *
 * Called first thing in the proxy, before the throttle decides, so that a
 * refused request is still counted — a limit that hides the traffic it turns
 * away is a limit nobody can tune. The whole body is wrapped: this runs in front
 * of every response on the site, and a throw here is an outage caused by
 * bookkeeping, which is the least defensible kind there is.
 *
 * The tier is passed in rather than worked out here, because the proxy has
 * already decided it and deciding it twice is how the counters and the limiter
 * come to disagree about what happened. The rollup now records what the caller
 * was actually metered as, sponsor keys included.
 *
 * @param {import('next/server').NextRequest} request
 * @param {string} [tier] the allowance the proxy placed this caller in
 * @param {boolean} [refused] whether the limiter turned this request away
 * @returns {void}
 */
export function countRequest(request, tier = 'anon', refused = false) {
  try {
    if (!started) {
      started = true;
      // Lazily, and from here rather than at module load: the flush needs a
      // database connection, and opening one as a side effect of importing a
      // module is how a build-time import ends up trying to reach Turso.
      startFlushing((rows) => traffic.recordTraffic(db(), rows));
    }

    record({
      hour: new Date().toISOString().slice(0, 13),
      agent: classifyAgent(request.headers.get('user-agent')),
      bucket: classifyPath(request.nextUrl?.pathname ?? new URL(request.url).pathname),
      tier,
      refused,
    });
  } catch {
    // Counted nothing. The response is unaffected, which is the point.
  }
}
