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

/**
 * How long any of these warms may take before it is abandoned.
 *
 * Ten minutes, and it was 150 seconds until production kept refusing to fit in
 * that. `stats-warm-skipped ms=150010` had been logged on every tick for days,
 * and `directory-warm-skipped ms=150002` landed on the very first tick after the
 * directory warm shipped. Raised to 600 s, that same directory warm completed in
 * **175 s** — it was never far over the line, but it was over it, and the whole
 * value of a warm is the entry it writes. An abandoned one writes nothing while
 * still paying for every row it read.
 *
 * The numbers are simply large: `countFeeds` alone is 49 s against 476,000 rows,
 * `countFeedsByKind` is a `group by category` no index covers, and
 * `categoryStats` is heavier than either.
 *
 * Affordable here in a way it never would be on a request path. These run once
 * an hour and they are reads: the whole tick is a few million rows, tens of
 * millions a day, against the ~16,200M left in the month's quota. The
 * per-request scans they replace are what spent 83.8 *billion* rows and took the
 * quota to 84% in the first place.
 *
 * The hourly interval, not this number, bounds the job: `statsTick` holds a
 * `warming` flag, so a slow warm delays the next tick rather than stacking up
 * beside itself.
 */
const WARM_TIMEOUT_MS = 600_000;

/** How much growth history the breakdown carries; matches the web's GROWTH_DAYS. */
const GROWTH_DAYS = 30;

/** How many blogs the directory index lists; matches the web's `INDEX_LIMIT`. */
const INDEX_LIMIT = 60;

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

/**
 * The same treatment for the homepage's three reads.
 *
 * ## Why this has to exist, and not just a wider staleness window
 *
 * `remember` fills its own cache from readers: past the TTL a reader triggers
 * `refresh()`, which recomputes behind them. That works only if the computation
 * can finish inside the timeout the *page* is willing to wait — and for this key
 * it cannot. `countFeedsByKind` is a `group by category` over 476,000 rows with
 * no covering index, so every refresh is abandoned at 20 seconds and the entry
 * is never renewed.
 *
 * Which leaves the entry ageing out with nothing able to replace it. Widening
 * `INDEX_MAX_STALE_MS` bought time and not a fix: once Redis dropped the key the
 * homepage had nothing to serve, waited its 20 seconds for a computation that
 * was always going to fail, and rendered the empty-directory branch — a
 * directory of 476,000 feeds reporting itself as having none. That is worse than
 * the slow page it replaced, and it is what production did on 2026-08-25 within
 * minutes of the staleness change deploying.
 *
 * So the writer moves here, where a 150-second deadline is allowed and the read
 * actually completes. The web side keeps `remember` exactly as it is: it finds a
 * warm entry and serves it, and its own doomed refreshes become harmless.
 *
 * Priming on the same tick as the category breakdown is deliberate — both are
 * whole-table reads and running them together keeps the number of full scans
 * this database sees to one burst an hour rather than two.
 *
 * @param {{ log?: (event: string, fields?: object) => void, client?: any }} [opts]
 * @returns {Promise<{ ok: boolean, ms: number, cached: boolean, error?: string }>}
 */
export async function warmDirectoryCache(opts = {}) {
  const started = Date.now();
  const log = opts.log ?? (() => {});

  /** @type {import('@libsql/client').Client|null} */
  let db = null;
  try {
    db = connect({ timeoutMs: WARM_TIMEOUT_MS, queue: false });

    // Shape and key must match `apps/web/src/lib/directory.js` exactly: it
    // destructures all three, and a mismatch here is an empty homepage that no
    // error anywhere would explain.
    const [rows, total, byKind] = await Promise.all([
      q.listFeeds(db, { limit: INDEX_LIMIT }),
      q.countFeeds(db),
      q.countFeedsByKind(db),
    ]);
    const cached = await primeCache('directoryIndex', { rows, total, byKind }, {
      client: opts.client,
    });

    const ms = Date.now() - started;
    log('directory-warmed', { ms, total, rows: rows?.length ?? 0, cached });
    return { ok: true, ms, cached };
  } catch (error) {
    const ms = Date.now() - started;
    // `…-skipped` rather than `…-error`, for the reason above: the page has a
    // cached answer and the operational-error panel treats a trailing "error"
    // as an alarm.
    const reason = error instanceof Error ? error.message : String(error);
    log('directory-warm-skipped', { ms, reason });
    return { ok: false, ms, cached: false, error: reason };
  } finally {
    try { db?.close(); } catch { /* closing a broken client is not a failure */ }
  }
}

/**
 * The status page's own counts.
 *
 * ## Why this is not the caching `liveStats` forbids
 *
 * What that function guards is a frozen *alarm*, and the alarm is not stored
 * here. `idleMinutes` is re-derived on every request from the cached
 * `lastSuccessAt` against the current clock, so it goes on climbing while the
 * crawler is down however old this entry is — a stalled crawler cannot read as
 * healthy from a primed value at any staleness. What is cached are counts, and
 * the page already prints `generatedAt` beside them precisely so it can say how
 * old they are.
 *
 * ## Why it is worth priming at all
 *
 * Uncached, /crawlstats is the one page guaranteed to fail exactly when it is
 * wanted — the same reasoning that produced `panel()` on the web side. On
 * 2026-08-25 it answered 500 after 65 seconds: 20 for the cached attempt, then
 * 45 for the uncached last resort, both against a read the database could no
 * longer finish.
 *
 * ## Why it is separate from the directory warm
 *
 * `crawlStats` is comparatively cheap — 4,975 ms measured healthy, against a
 * `group by category` over every row for the directory counts. Running them in
 * one function meant the expensive pair could time out and take this one down
 * with it, leaving the status page unprimed for the sake of a breakdown it does
 * not even use. They fail independently, so they are warmed independently.
 *
 * @param {{ log?: (event: string, fields?: object) => void, client?: any }} [opts]
 * @returns {Promise<{ ok: boolean, ms: number, cached: boolean, error?: string }>}
 */
/**
 * The two remaining panels on /crawlstats that no reader can prime.
 *
 * ## Why these two, measured rather than guessed
 *
 * With the liveness numbers and the directory counts warm, /crawlstats still
 * answered in exactly 20.2s — one `CHART_TIMEOUT_MS`, so something was still
 * waiting one out. Timing each panel against production on 2026-08-25 found two,
 * not the one I had assumed:
 *
 *     failingFeeds(50)      126,600ms
 *     jobBacklogs            66,792ms
 *     indexingHistory(24)       555ms
 *     queueHistory(48)          110ms
 *
 * The charts were never the problem. Both of these are far over the twenty
 * seconds a reader waits, so their entries can never be written from a page and
 * age out with nothing able to replace them — the same hole the directory index
 * had. They run in `Promise.all`, which is why two blocked panels still cost one
 * timeout rather than two.
 *
 * ## Why each key gets its own try
 *
 * `failingFeeds` is keyed by limit — the page asks for 50 and the JSON endpoint
 * for 20 — so both need priming or whichever asked second is back to waiting.
 * Three independent keys, three independent failures: one that cannot be read
 * must not cost the others their turn, which is the mistake that put `crawlStats`
 * behind the directory counts in the first place.
 *
 * @param {{ log?: (event: string, fields?: object) => void, client?: any }} [opts]
 * @returns {Promise<{ ok: boolean, ms: number, warmed: string[] }>}
 */
export async function warmPanelCaches(opts = {}) {
  const started = Date.now();
  const log = opts.log ?? (() => {});

  /** @type {import('@libsql/client').Client|null} */
  let db = null;
  /** @type {string[]} */
  const warmed = [];

  try {
    db = connect({ timeoutMs: WARM_TIMEOUT_MS, queue: false });

    /** @param {string} key @param {() => Promise<unknown>} read */
    const one = async (key, read) => {
      const at = Date.now();
      try {
        const value = await read();
        await primeCache(key, value, { client: opts.client });
        warmed.push(key);
        log('panel-warmed', { key, ms: Date.now() - at });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log('panel-warm-skipped', { key, ms: Date.now() - at, reason });
      }
    };

    // Cheapest first, same as the tick itself.
    await one('jobBacklogs', () => q.jobBacklogs(db));
    await one('failingFeeds:50', () => q.failingFeeds(db, 50));
    await one('failingFeeds:20', () => q.failingFeeds(db, 20));

    return { ok: warmed.length > 0, ms: Date.now() - started, warmed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log('panel-warm-skipped', { key: 'connect', ms: Date.now() - started, reason });
    return { ok: false, ms: Date.now() - started, warmed };
  } finally {
    try { db?.close(); } catch { /* closing a broken client is not a failure */ }
  }
}

export async function warmLiveStatsCache(opts = {}) {
  const started = Date.now();
  const log = opts.log ?? (() => {});

  /** @type {import('@libsql/client').Client|null} */
  let db = null;
  try {
    db = connect({ timeoutMs: WARM_TIMEOUT_MS, queue: false });

    const value = await q.crawlStats(db);
    const cached = await primeCache('crawlStats', value, { client: opts.client });

    const ms = Date.now() - started;
    log('livestats-warmed', { ms, total: value?.total ?? null, cached });
    return { ok: true, ms, cached };
  } catch (error) {
    const ms = Date.now() - started;
    const reason = error instanceof Error ? error.message : String(error);
    log('livestats-warm-skipped', { ms, reason });
    return { ok: false, ms, cached: false, error: reason };
  } finally {
    try { db?.close(); } catch { /* closing a broken client is not a failure */ }
  }
}
