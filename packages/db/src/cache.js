/**
 * A read-through cache for the expensive halves of /crawlstats.
 *
 * ## Why this exists
 *
 * `/api/crawlstats` fans out eleven reads and returns when the slowest one
 * does. Measured against production on 2026-08-21:
 *
 *     categoryStats            30,005ms  (timed out)
 *     jobBacklogs              11,255ms
 *     failingFeeds(20)          5,172ms
 *     crawlStats                4,975ms
 *     ...the other seven        under 600ms each
 *     Promise.all of all 11    30,008ms
 *
 * The endpoint answered in 118 seconds. `categoryStats` alone sets the floor,
 * and **no rewrite fixes it**: it is a `group by category` over 476,715 rows,
 * and on the same connection a bare `count(*)` of that table is 6.9s while
 * `select category, count(*) … group by category` does not finish inside the
 * client's 30s deadline. A conditional aggregate was the bug in `crawlStats`
 * (PR #96) and removing the CASEs here changes nothing, because the cost is
 * visiting every row for a column that no index covers.
 *
 * So the fix is to stop doing it on the request path.
 *
 * ## Why Redis rather than the per-process cache already here
 *
 * `apps/web/src/lib/crawlstats.js` caches these in module scope, which is right
 * as far as it goes and has two holes this closes. It dies with the process, so
 * every deploy re-pays the full cost on the next request; and it is per
 * instance, so it cannot be shared. Redis also adds **no writes to Turso**,
 * which matters more than usual here: the write path is the binding constraint
 * on this database, and a rollup table would put the fix on the hot side of it.
 *
 * ## Why stale-while-revalidate, and not a plain TTL
 *
 * A plain cache never fills for the read that needs it most. `categoryStats`
 * does not merely run slowly, it *fails* — so a "compute on miss, store on
 * success" cache stores nothing, and every single request pays 30 seconds
 * forever. That is the state production is in.
 *
 * Serving stale while refreshing in the background inverts it: one success, any
 * time, is enough for every later reader to be served instantly, and the
 * refresh that keeps failing costs nobody a wait. A value that cannot be
 * recomputed is returned however old it is, because a month-old category
 * breakdown is a better answer than a thirty-second hang.
 *
 * ## What must not be cached this way
 *
 * The liveness numbers. This page exists to catch a stalled crawler, and one
 * that reads "healthy" from a cache is the single failure that would make it
 * worthless. Those keys take a short `ttlMs` and a small `maxStaleMs`, so
 * staleness is bounded by seconds rather than by whether a refresh succeeds --
 * see the callers for which is which.
 */

/** @type {Map<string, Promise<unknown>>} in-flight refreshes, per process */
const inFlight = new Map();

/** @type {{ client: unknown, url: string }|null} */
let shared = null;

/**
 * The process's Redis client, or null when no `REDIS_URL` is configured.
 *
 * Lazily imported rather than pulled in at module load: this module is reached
 * from Next server code, and `ioredis` at the top level drags a node-only
 * dependency into any bundle that so much as touches `@rssamplifier/db`.
 *
 * @param {string} [url]
 * @returns {Promise<any|null>}
 */
export async function redisClient(url = process.env['REDIS_URL'] ?? '') {
  if (!url) return null;
  if (shared && shared.url === url) return shared.client;

  try {
    const { default: Redis } = await import('ioredis');
    // A cache must never be the reason a page is slow. `commandTimeout` is the
    // load-bearing option: without it a Redis that accepts connections but
    // stops answering leaves every `get` hanging, and the cache becomes the
    // stall it was added to remove.
    //
    // The offline queue is deliberately left on. Railway's Redis is reached
    // over internal DNS, so the first request after a cold start can arrive
    // before the socket is ready; queueing briefly is better than failing those
    // outright, and `commandTimeout` still bounds the wait either way. No
    // `family` option for the same reason the write queue needs none -- the
    // same URL already works there.
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      commandTimeout: 1_000,
      connectTimeout: 3_000,
    });
    // Without a listener an ioredis connection error is an unhandled 'error'
    // event, which takes the process down -- a cache outage becoming a site
    // outage is the opposite of the point.
    client.on('error', () => {});
    shared = { client, url };
    return client;
  } catch {
    return null;
  }
}

/**
 * Run `fn`, giving up after `ms`.
 *
 * The underlying read keeps running -- there is no cancellation in the libSQL
 * client -- but nobody is waiting on it any more, which is the part that
 * matters for a response deadline.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    fn().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Read `key` from the cache, recomputing it when it is old enough to matter.
 *
 * Returns `fallback` (default null) only when there is nothing cached *and*
 * the computation failed -- callers already treat that as "chart unavailable"
 * rather than as an error, which is why a failed read here must not throw.
 *
 * @template T
 * @param {string} key
 * @param {{
 *   ttlMs: number,
 *   maxStaleMs?: number,
 *   timeoutMs?: number,
 *   fallback?: T|null,
 *   client?: any,
 * }} opts
 * @param {() => Promise<T>} compute
 * @returns {Promise<T|null>}
 */
export async function remember(key, opts, compute) {
  const {
    ttlMs,
    maxStaleMs = 24 * 60 * 60 * 1000,
    timeoutMs = 20_000,
    fallback = null,
  } = opts;

  const client = opts.client !== undefined ? opts.client : await redisClient();

  // No Redis configured is not an error, it is the local and the test case:
  // behave exactly as the uncached code did.
  if (!client) {
    try {
      return await withTimeout(compute, timeoutMs);
    } catch {
      return fallback;
    }
  }

  const entry = await readEntry(client, key);
  const age = entry ? Date.now() - entry.at : Infinity;

  if (entry && age < ttlMs) return entry.value;

  // Stale but usable: answer now, and refresh behind the reader. This is the
  // path that makes a 30-second read invisible.
  if (entry && age < maxStaleMs) {
    refresh(client, key, compute, timeoutMs);
    return entry.value;
  }

  // Nothing usable cached, so this reader has to wait for it.
  try {
    const value = await withTimeout(compute, timeoutMs);
    await writeEntry(client, key, value, maxStaleMs);
    return value;
  } catch {
    // It failed, and an expired value is still a better answer than none --
    // this is what keeps `categoryStats` serving after it stops completing.
    return entry ? entry.value : fallback;
  }
}

/**
 * Recompute in the background, at most once at a time per key.
 *
 * Deduped because a page that refreshes every fifteen seconds would otherwise
 * start a new thirty-second scan on every request and pile them up against the
 * database this is trying to spare.
 *
 * @param {any} client
 * @param {string} key
 * @param {() => Promise<unknown>} compute
 * @param {number} timeoutMs
 */
function refresh(client, key, compute, timeoutMs) {
  if (inFlight.has(key)) return;

  const task = withTimeout(compute, timeoutMs)
    .then((value) => writeEntry(client, key, value, 24 * 60 * 60 * 1000))
    // A background refresh that fails is not an event: the reader already has
    // an answer, and the next one will try again.
    .catch(() => {})
    .finally(() => inFlight.delete(key));

  inFlight.set(key, task);
}

/**
 * @param {any} client
 * @param {string} key
 * @returns {Promise<{ at: number, value: any }|null>}
 */
async function readEntry(client, key) {
  try {
    // Bounded independently of `commandTimeout`, because the client here may be
    // a stand-in rather than ioredis, and a cache lookup that can hang is not a
    // cache. Well under any of the read timeouts it is protecting.
    const raw = await withTimeout(() => client.get(cacheKey(key)), 1_500);
    if (!raw) return null;
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    // Unreadable or unparseable is the same as absent. A cache cannot be
    // allowed to fail a request.
    return null;
  }
}

/**
 * Stored with an expiry well past `maxStaleMs` so that the *policy* about how
 * stale is too stale lives in one place -- `remember` -- rather than being
 * split between here and Redis's own eviction.
 *
 * @param {any} client
 * @param {string} key
 * @param {unknown} value
 * @param {number} maxStaleMs
 */
async function writeEntry(client, key, value, maxStaleMs) {
  try {
    const body = JSON.stringify({ at: Date.now(), value }, (_, v) =>
      typeof v === 'bigint' ? Number(v) : v,
    );
    await withTimeout(
      () => client.set(cacheKey(key), body, 'PX', Math.max(maxStaleMs * 2, 60_000)),
      1_500,
    );
  } catch {
    // Failing to store is survivable: the value was still computed and is
    // being returned. The next reader simply pays for it again.
  }
}

/**
 * @param {string} key
 * @returns {string}
 */
function cacheKey(key) {
  return `rsa:stats:${key}`;
}

/**
 * Store a value under `key` as though a reader had just computed it.
 *
 * For work that cannot be done on a request: the category breakdown takes ~59
 * seconds, so no page can wait for it and a cache that only fills from readers
 * never fills at all. A background job computes it on a patient connection and
 * primes the same key, and every reader is then served from Redis.
 *
 * Goes through `writeEntry` rather than reimplementing the envelope, so the
 * warmer and the reader cannot drift apart on the format.
 *
 * @param {string} key
 * @param {unknown} value
 * @param {{ client?: any, maxStaleMs?: number }} [opts]
 * @returns {Promise<boolean>} whether it was stored
 */
export async function primeCache(key, value, opts = {}) {
  const client = opts.client !== undefined ? opts.client : await redisClient();
  if (!client) return false;
  await writeEntry(client, key, value, opts.maxStaleMs ?? 24 * 60 * 60 * 1000);
  return true;
}

/** Test seam: forget the in-flight refreshes between cases. */
export function resetCacheState() {
  inFlight.clear();
  shared = null;
}
