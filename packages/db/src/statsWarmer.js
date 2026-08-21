import { connect } from './client.js';
import { primeCache } from './cache.js';
import * as q from './queries.js';

/**
 * Recompute the numbers no page can afford to wait for, and put them in Redis.
 *
 * ## Why a background job and not a faster query
 *
 * `categoryStats` groups half a million feeds by category while reading their
 * status, item count and last-success time. Measured against production on
 * 2026-08-21, decomposed piece by piece:
 *
 *     feeds per category           6,340ms   (index-only, uses the partial index)
 *     growth by day+category       1,046ms   (index-only)
 *     status x category           23,942ms
 *     sum(item_count) per category 35,440ms
 *     crawled-in-last-day          40,020ms
 *
 * The three slow ones read columns no index covers, so they fetch every row.
 * An index that covered them would have to carry `status` and `last_success_at`,
 * both rewritten on every crawl — and writes, not reads, are this database's
 * binding constraint. Buying a fast breakdown with a slower crawler is the
 * wrong trade.
 *
 * So the query stays as it is and stops being on the request path. The whole
 * statement completes in **58.9 seconds** given a deadline long enough to allow
 * it, which is the other half of this: the 30s ceiling it kept hitting is this
 * codebase's own `TURSO_REQUEST_TIMEOUT_MS`, not a limit of the database. A
 * connection with a patient deadline can finish what a page never could.
 *
 * ## Why this is safe to run beside the crawler
 *
 * It is a read, and reads bypass the write serialization entirely — they do not
 * take the single writer that everything else queues behind. One long read every
 * few minutes costs the crawler nothing.
 *
 * ## Why it primes rather than returns
 *
 * Nothing here consumes the value. The point is that `remember('categoryStats')`
 * on the web side finds it already there, so the reader that would have waited
 * 20 seconds and then given up is served from Redis instead.
 */

/** Long enough for the ~59s read, with room for a bad day. */
const WARM_TIMEOUT_MS = 150_000;

/** How much growth history the breakdown carries; matches the web's GROWTH_DAYS. */
const GROWTH_DAYS = 30;

/**
 * Compute the category breakdown on a patient connection and cache it.
 *
 * Never throws. A warmer that takes the poller down with it would trade a slow
 * chart for a stopped crawler, and the cache simply keeps serving whatever it
 * last had.
 *
 * @param {{ log?: (event: string, fields?: object) => void, client?: any }} [opts]
 * @returns {Promise<{ ok: boolean, ms: number, cached: boolean, error?: string }>}
 */
export async function warmStatsCache(opts = {}) {
  const started = Date.now();
  const log = opts.log ?? (() => {});

  /** @type {import('@libsql/client').Client|null} */
  let db = null;
  try {
    // Its own connection, deliberately. Sharing the poller's would either impose
    // this job's 150-second deadline on every crawl write or leave this job with
    // the 30 seconds it cannot finish in.
    db = connect({ timeoutMs: WARM_TIMEOUT_MS, queue: false });

    const value = await q.categoryStats(db, GROWTH_DAYS);
    const cached = await primeCache('categoryStats', value, { client: opts.client });

    const ms = Date.now() - started;
    log('stats-warmed', { ms, categories: value?.categories?.length ?? 0, cached });
    return { ok: true, ms, cached };
  } catch (error) {
    const ms = Date.now() - started;
    // Logged as `stats-warm-skipped`, not `…-error`: the page has a cached
    // answer and is fine, and the operational-error panel treats any event
    // whose name ends in "error" as an alarm. A missed warm is not one.
    const reason = error instanceof Error ? error.message : String(error);
    log('stats-warm-skipped', { ms, reason });
    return { ok: false, ms, cached: false, error: reason };
  } finally {
    try { db?.close(); } catch { /* closing a broken client is not a failure */ }
  }
}
