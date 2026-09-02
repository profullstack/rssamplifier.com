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

/**
 * Which allowance a request arrived under.
 *
 * Cookie presence only, exactly as `proxy` decides it, and for the same reason:
 * validating the session would mean a database lookup in front of every request
 * in the directory, which is precisely the cost all of this exists to measure
 * rather than add to. A forged cookie miscounts one row in a rollup, and there
 * is no version of that worth a query.
 *
 * `key` is not detectable here — an API key is read inside `apiguard`, after the
 * proxy has already run — so a keyed API call currently counts as `anon`. That
 * is honest rather than convenient: it means the `anon` bucket is an upper
 * bound, and the first thing the tiering work should do is close the gap.
 *
 * @param {import('next/server').NextRequest} request
 * @returns {string}
 */
function tierOf(request) {
  return request.cookies?.get('rsa_session')?.value ? 'session' : 'anon';
}

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
 * @param {import('next/server').NextRequest} request
 * @returns {void}
 */
export function countRequest(request) {
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
      tier: tierOf(request),
    });
  } catch {
    // Counted nothing. The response is unaffected, which is the point.
  }
}
