import { q, alerts, remember } from '@rssamplifier/db';

import { db } from './db.js';

/**
 * The slow half of /crawlstats, cached in Redis.
 *
 * The status numbers on that page have to be current to the second — a stalled
 * crawler that reads "healthy" because the answer came from a cache is the one
 * failure the page exists to catch. The breakdowns below are the opposite kind
 * of number: a directory of half a million feeds does not change shape between
 * two fifteen-second refreshes, and recomputing a group-by over every feed on
 * each one bills a full table scan for an answer that is the same all morning.
 *
 * ## Why this moved out of the process
 *
 * These caches used to live in module scope, which was right as far as it went
 * and had two holes. It died with the process, so every deploy re-paid the full
 * cost on the next request; and it was per instance, so nothing was shared.
 *
 * The second hole is the one that bit. `categoryStats` stopped merely being
 * slow and started *failing* — measured 2026-08-21, it does not finish inside
 * the client's 30s deadline against 476,715 feeds — and a cache that only
 * stores successes never stores anything. So every request paid 30 seconds, for
 * ever, and `/api/crawlstats` answered in 118. Redis plus serve-stale-on-failure
 * means one success, any time, is enough for every later reader.
 *
 * Redis also adds no writes to Turso, which matters more than usual here: the
 * write path is this database's binding constraint, so a rollup table would put
 * the fix on the hot side of it.
 *
 * ## What is cached, and what is derived
 *
 * Facts are cached; anything computed against "now" is derived at serve time.
 * An hour label or an idle-minutes count baked into a cached blob is frozen,
 * and a frozen liveness number is exactly the lie this page must not tell. So
 * `queueHistory` caches the sparse rows and fills the window on the way out,
 * and `crawlStats` (in the route) re-derives `idleMinutes` from the cached
 * `lastSuccessAt` timestamp.
 */

/** How long an hourly rollup read is trusted. */
const HISTORY_TTL_MS = 60 * 1000;

/**
 * How long a category breakdown is trusted.
 *
 * Matched to the poller's `STATS_WARM_SECONDS`, and that pairing is the whole
 * point rather than a coincidence. Past this age `remember` fires a background
 * `refresh()`, and on this key the refresh is a `categoryStats` full scan that
 * takes 86–150 seconds against half a million feeds — it cannot finish inside
 * `CHART_TIMEOUT_MS` and never once has. So a reader arriving after the TTL
 * lapsed was starting a doomed 20-second scan on the one instance the warmer
 * was already scanning, and throwing the result away. (`remember` dedupes to
 * one in-flight refresh per key, so this was one wasted scan at a time, not
 * one per reader — still one too many.)
 *
 * Five minutes made that certain: the warmer is abandoned at its own 150s
 * ceiling roughly a third of the time, and each time it was, the entry went
 * stale and the web service picked up the same scan the poller had just given
 * up on. An hour means the warmer refreshes it before a reader ever asks.
 *
 * Safe because the value is served stale for a day anyway
 * (`CHART_MAX_STALE_MS`): the honest ceiling on how old this may get was never
 * the TTL.
 */
const CATEGORY_TTL_MS = 60 * 60 * 1000;

/**
 * How stale a breakdown may get before a reader waits for a fresh one.
 *
 * Generous on purpose. These are shape-of-the-directory numbers, and the whole
 * reason the window is wide is that the alternative — when the underlying read
 * is failing — is no chart at all rather than a slightly old one.
 *
 * Widened from a day to a month on 2026-08-25, because a day was not a ceiling
 * on staleness so much as a delayed trap. Past `maxStaleMs`, `remember` stops
 * serving the entry and makes the reader wait out `CHART_TIMEOUT_MS` instead —
 * and then, when the recompute fails, returns *that same expired entry* from
 * its catch. `categoryStats` takes 86–150 seconds and so fails every time, so
 * the twenty seconds bought the reader precisely nothing and left the entry
 * just as unrenewable for the next one. The identical cliff pinned `/` at
 * 20.35 s on every request until `directory.js` was widened the same way.
 *
 * Nothing guarded by this constant is a liveness signal — those are `liveStats`
 * and `logActivity`, which keep their own short ceilings a few lines down and
 * are what stops this page claiming a dead crawler is alive.
 */
const CHART_MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Shorter than the client's own 30s deadline, so a read that is going to hang
 * gives the page back before the browser gives up on it.
 */
const CHART_TIMEOUT_MS = 20 * 1000;

/**
 * What a reader waits for the category breakdown when nothing is cached.
 *
 * Two seconds, and deliberately nothing like the others. This is the one read on
 * the page we have direct evidence cannot be computed at all right now: warmed
 * on its own connection with a ten-minute deadline it ran for **300.7 seconds**
 * and came back `fetch failed` — not a timeout, the connection died under it.
 * `categoryStats` is nine conditional aggregates over 476,000 rows and no index
 * covers the columns it groups by.
 *
 * So the twenty seconds a reader used to spend here were spent learning
 * something already known, and ending in the same fallback either way — the same
 * shape of waste as the `maxStaleMs` cliff this file and `directory.js` were
 * widened to remove. /crawlstats answered 200 in 20.3s with every other panel
 * primed and fast; this was the whole of it.
 *
 * Safe because a reader is not the writer here. When the entry *is* warm it is
 * served from Redis and this number is never consulted; when the database
 * recovers it is `warmStatsCache` on its patient connection that refills the
 * key, not a refresh started from a page. All this bounds is how long the page
 * waits before drawing the chart's own empty state.
 */
const CATEGORY_TIMEOUT_MS = 2 * 1000;

/**
 * The TTL for any key the poller warms, and it must exceed the warm interval.
 *
 * ## The trap this exists to close
 *
 * `remember` starts a background `refresh()` for any entry older than its TTL.
 * While a key has *nothing* cached that branch is unreachable — the reader takes
 * the blocking path instead — so an unprimed expensive key generates no
 * background load at all. Priming it changes that: from the first warm onwards
 * every reader past the TTL fires a refresh, deduped to one in flight per key
 * but immediately restarted by the next reader when it finishes.
 *
 * With the old TTLs that turned three of these into a permanent loop. Measured
 * 2026-08-25, the reads behind them are `crawlStats` 57–77 s, `jobBacklogs`
 * 60–67 s and `failingFeeds` 96–127 s, against TTLs of ten and sixty seconds —
 * so the web service was running all three back to back, for ever, from its own
 * request path. /crawlstats went from 20.2 s before priming to **99–104 s and
 * timeouts after**, on an idle tick. Priming made it worse, which is the
 * opposite of the point.
 *
 * ## Why ninety minutes
 *
 * The poller warms hourly, and the TTL has to be longer than that or the entry
 * is stale-by-design before the next warm lands and readers refresh it anyway.
 * Ninety minutes leaves half an hour of slack for a warm that runs long — and
 * they do run long here: the directory warm alone takes 175–195 s.
 *
 * The warmer is the writer for these keys. A reader's job is to be served.
 */
const PRIMED_TTL_MS = 90 * 60 * 1000;

/**
 * How long an uncached panel read may take before the page gives up on it.
 *
 * `panel()` was written to stop one failing read taking the status page down,
 * and it caught the wrong half of that. It catches *rejection*; it does nothing
 * about a read that simply never answers — and on this database a libSQL request
 * demonstrably can never answer. An empty write transaction probed from outside
 * did not return in 280 seconds, and `warmStatsCache` gets `fetch failed` after
 * 300 rather than a timeout.
 *
 * Measured 2026-08-25: with every cached panel primed and `/api/crawlstats`
 * answering in **2.39 s**, the page itself sent **zero bytes in 120 s**. Not a
 * slow render and not a post-flush throw — the single `await` never settled, and
 * the only things in it without a deadline of their own were these six reads.
 * The cached readers all bound themselves through `remember`; these did not.
 *
 * Five seconds is deliberately far above what they cost — the slowest,
 * `recentlyCrawled(15)`, measured 572 ms, and the rest are 90–300 ms — so this
 * never trims a working read. It exists only to convert "hangs for ever" into
 * "that panel is missing", which is the whole promise `panel()` was making.
 */
const PANEL_TIMEOUT_MS = 5 * 1000;

/** How much history the charts draw. */
export const HISTORY_HOURS = 24;
export const GROWTH_DAYS = 30;

/**
 * How far back the burndown looks.
 *
 * Wider than the throughput charts on purpose. Throughput is read for "is it
 * running right now", which a day answers; a queue is read for "is this going
 * to zero, and when", and two days is the shortest window where the slope of
 * something that takes weeks to drain is visible at all.
 */
export const QUEUE_HOURS = 48;

/**
 * Crawler throughput, hour by hour.
 *
 * Empty rather than throwing if the read fails. The poller owns schema
 * migration and the web service does not wait for it, so there is a window on
 * the deploy that ships `crawl_hourly` in which this table does not exist yet —
 * and losing a chart must not take down the page that says whether the crawler
 * is alive.
 *
 * @returns {Promise<Awaited<ReturnType<typeof q.indexingHistory>>>}
 */
export async function indexingHistory() {
  const value = await remember(
    'indexingHistory',
    { ttlMs: HISTORY_TTL_MS, maxStaleMs: CHART_MAX_STALE_MS, timeoutMs: CHART_TIMEOUT_MS, fallback: [] },
    () => q.indexingHistory(db(), HISTORY_HOURS),
  );
  return value ?? [];
}

/**
 * Every queue's depth hour by hour, dense across the window.
 *
 * The rows come back sparse — one per hour actually sampled — and the chart
 * needs a slot per hour either way, because the gaps are the point. A poller
 * that stopped for six hours must appear as six missing points rather than as a
 * line drawn straight through them, which is what a chart fed only the rows it
 * has would show.
 *
 * So this fills the window and leaves `null` where nothing was written down.
 * The fill happens *after* the cache rather than before it: the hour labels are
 * built from the current time, so a cached dense array would still be carrying
 * yesterday's axis tomorrow. The sparse rows are the fact worth keeping.
 *
 * Empty rather than throwing, on the same reasoning as `indexingHistory`: the
 * poller owns migration, so there is a deploy window where `queue_hourly` does
 * not exist yet and losing a chart must not take the page with it.
 *
 * @returns {Promise<{ hours: string[], series: Record<string, Array<number|null>> }>}
 */
export async function queueHistory() {
  const rows = await remember(
    'queueHistory',
    { ttlMs: HISTORY_TTL_MS, maxStaleMs: CHART_MAX_STALE_MS, timeoutMs: CHART_TIMEOUT_MS, fallback: null },
    () => q.queueHistory(db(), QUEUE_HOURS),
  );

  if (!rows) return { hours: [], series: {} };

  const byHour = new Map(rows.map((r) => [r.hour, r]));

  const hours = [];
  const now = Date.now();
  for (let i = QUEUE_HOURS - 1; i >= 0; i--) {
    hours.push(new Date(now - i * 3_600_000).toISOString().slice(0, 13));
  }

  const pick = (key) => hours.map((h) => (byHour.has(h) ? Number(byHour.get(h)[key]) : null));

  return {
    hours,
    series: {
      due: pick('due'),
      firstCrawl: pick('firstCrawl'),
      cards: pick('cards'),
      authors: pick('authors'),
    },
  };
}

/**
 * The directory by category, with each category's growth curve.
 *
 * The slowest read on the page and the reason this module exists. It wants five
 * columns per feed (category, status, created_at, last_success_at, item_count)
 * and three of them are rewritten on every crawl, so an index wide enough to
 * cover it would cost more on the write path than the read is worth. Measured
 * against production it no longer completes at all: a bare `count(*)` of
 * `feeds` is 6.9s and `select category, count(*) … group by category` exceeds
 * the 30s client deadline. Removing its conditional aggregates — the fix that
 * worked for `crawlStats` in PR #96 — does not help, because the cost is
 * visiting every row for a column no index covers.
 *
 * Which is why it is served stale for up to a day rather than recomputed:
 * five minutes and five minutes plus a failed thirty-second scan are the same
 * answer, and a day-old breakdown beats the empty one this returned before.
 *
 * @returns {Promise<Awaited<ReturnType<typeof q.categoryStats>>>}
 */
export async function categoryStats() {
  const value = await remember(
    'categoryStats',
    {
      ttlMs: CATEGORY_TTL_MS,
      maxStaleMs: CHART_MAX_STALE_MS,
      timeoutMs: CATEGORY_TIMEOUT_MS,
      fallback: null,
    },
    () => q.categoryStats(db(), GROWTH_DAYS),
  );

  return value ?? { total: 0, days: [], categories: [] };
}

/**
 * How long the liveness numbers are trusted.
 *
 * Ten seconds was right when a reader was the only thing that ever wrote this
 * key: it cost one read per fifteen-second page refresh, and the read was five
 * seconds. It became wrong the moment the poller started priming it, because a
 * ten-second TTL against a read that now takes 57–77 s means every reader
 * restarts it the instant the last one finishes. See `PRIMED_TTL_MS`.
 *
 * What that costs in freshness is counts, not the alarm — `idleMinutes` is
 * re-derived from the cached `lastSuccessAt` on every request, so a stalled
 * crawler cannot read as healthy however old this entry is, and `generatedAt` is
 * printed beside the numbers so the page says how old they are.
 */
const STATS_TTL_MS = PRIMED_TTL_MS;

/**
 * The status numbers, cached briefly — and the derivation that makes that safe.
 *
 * `crawlStats` was deliberately never cached, because a stalled crawler reading
 * "healthy" is the one failure /crawlstats exists to catch. That reasoning is
 * right about `idleMinutes` and wrong about everything else on the object: the
 * counts are counts, but `idleMinutes` is computed as `now - lastSuccessAt` at
 * the moment the query runs, so caching the object *freezes it*. A crawler that
 * died would go on reporting the same cheerful number until the entry expired.
 *
 * So the fact is cached and the derivation is redone here. `lastSuccessAt` is a
 * timestamp — it does not go stale, it just gets further away — and recomputing
 * the gap against the current clock gives a number that keeps climbing while
 * the crawler is down, which is exactly the alarm that must not be cacheable.
 * `generatedAt` is left as the moment the read actually happened, so the page
 * can be honest about how old the counts beside it are.
 *
 * The read itself measured 4,975ms against production, which is why it is worth
 * doing at all.
 *
 * @returns {Promise<Awaited<ReturnType<typeof q.crawlStats>>>}
 */
export async function liveStats() {
  const stats = await remember(
    'crawlStats',
    {
      ttlMs: STATS_TTL_MS,
      // Two hours, raised from two minutes on 2026-08-25, and it is worth being
      // exact about what that does and does not loosen.
      //
      // It does not loosen the alarm. `idleMinutes` is never stored — it is
      // re-derived below from the cached `lastSuccessAt` against the current
      // clock, so it climbs while the crawler is down however old this entry is.
      // A stalled crawler cannot read as healthy from here at any staleness.
      //
      // What may now be up to two hours old are the counts, which the page
      // already labels with `generatedAt` for exactly this reason. Two hours
      // because the poller primes this key once an hour: a shorter ceiling than
      // the priming interval means the primed value is never usable, and the
      // reader falls through to the 20s timeout — which is the trap that pinned
      // the homepage, one file over.
      //
      // The alternative is not fresher numbers, it is no page: with the read
      // failing, the old ceiling made /crawlstats answer 500 after 65 seconds,
      // failing precisely when the crawler was in the trouble it exists to
      // report.
      maxStaleMs: 2 * 60 * 60 * 1000,
      timeoutMs: CHART_TIMEOUT_MS,
      fallback: null,
    },
    () => q.crawlStats(db()),
  );

  // Nothing cached *and* the cached attempt failed, so this is the last resort:
  // read it fresh rather than let the page render nothing. Deliberately still
  // uncached — the liveness numbers are the one thing this page must never
  // serve from a cache — but bounded, which it was not.
  //
  // Unbounded, this line was what actually took /crawlstats down on 2026-08-25.
  // `remember` had already spent CHART_TIMEOUT_MS failing at exactly this query,
  // and this re-ran it with no deadline of its own: the libSQL client retries a
  // timed-out request three times at TURSO_REQUEST_TIMEOUT_MS, so the page sat
  // for ~90 s having read half a million rows twice, long past the point Next
  // had flushed the streamed shell and could still answer with a status. The
  // reader got a dead connection — `curl` reports `000`, no HTTP code at all —
  // and the second scan was pure quota: it was never going to succeed where the
  // first had just failed.
  //
  // 45 s rather than CHART_TIMEOUT_MS because the two attempts are not asking
  // the same question. The first is "is this cheap enough for a page to wait
  // on"; this one is "can it be read at all before the reader gives up". The
  // read measured 4,975 ms healthy, so 45 s still succeeds on a merely slow
  // database and only gives up on a wedged one.
  if (!stats) return await withDeadline(() => q.crawlStats(db()), 45_000);

  const lastSuccessAt = stats.lastSuccessAt ? String(stats.lastSuccessAt) : null;
  return {
    ...stats,
    idleMinutes: lastSuccessAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(lastSuccessAt)) / 60_000))
      : null,
  };
}

/**
 * The feeds failing hardest, for the table at the bottom of the page.
 *
 * 5,172ms against production: it sorts the whole error population. A minute old
 * is fine — a feed that has failed eleven times has not stopped failing since
 * the last refresh, and this list is read to find a pattern, not to catch an
 * event.
 *
 * Keyed by limit, because the page asks for 50 and the JSON endpoint for 20 --
 * one key would hand whichever asked second the wrong-length list.
 *
 * @param {number} [limit]
 * @returns {Promise<Awaited<ReturnType<typeof q.failingFeeds>>>}
 */
export async function failingFeeds(limit = 20) {
  const value = await remember(
    `failingFeeds:${limit}`,
    // `CHART_MAX_STALE_MS` rather than its own six hours, for the reason given
    // there: a ceiling is not a bound on staleness when the recompute fails, it
    // is a delayed 20-second wait ending in the same stale answer.
    // `PRIMED_TTL_MS`, not a minute: the poller warms both limits of this key,
    // and at 96–127 s a reader-triggered refresh never stops running.
    {
      ttlMs: PRIMED_TTL_MS,
      maxStaleMs: CHART_MAX_STALE_MS,
      timeoutMs: CHART_TIMEOUT_MS,
      fallback: [],
    },
    () => q.failingFeeds(db(), limit),
  );
  return value ?? [];
}

/**
 * How many accounts have alerts configured.
 *
 * Only tells a sender with nobody to serve from one that has stopped, so it
 * moves at the speed of people signing up and can be an hour old without
 * anybody being misled.
 *
 * @returns {Promise<number>}
 */
export async function alertingAccounts() {
  const value = await remember(
    'alertingAccounts',
    { ttlMs: 5 * 60 * 1000, maxStaleMs: CHART_MAX_STALE_MS, timeoutMs: CHART_TIMEOUT_MS, fallback: 0 },
    () => alerts.alertingAccountCount(db()),
  );
  return Number(value ?? 0);
}

/**
 * How long a job-board read is trusted.
 *
 * `PRIMED_TTL_MS` since the poller warms this key: at 60–67 s the read is longer
 * than the minute it used to be trusted for, so every reader started a refresh
 * that was still running when the next one arrived.
 */
const JOBS_TTL_MS = PRIMED_TTL_MS;

/**
 * The job board's backlogs, cached and served stale while it refreshes.
 *
 * A scan of `feeds` however well it is written: counting the directory by
 * status, by card state and by never-crawled means visiting every row, and
 * there are 476,715 of them. On an idle database that is 398ms, which is why it
 * shipped uncached; under the crawler's write load the same statement measured
 * 16.9 seconds, and 11.3 in the timing that prompted this change.
 *
 * A minute of staleness costs nothing here. These are backlogs of hundreds of
 * thousands of feeds draining at a few hundred an hour; they do not
 * meaningfully move between two views of a page that refreshes itself every
 * fifteen seconds.
 *
 * Null rather than zeroes when there is nothing to serve: a job board showing
 * "0 waiting" because the read failed reads as "all caught up", where a missing
 * board is merely missing.
 *
 * @returns {Promise<Awaited<ReturnType<typeof q.jobBacklogs>>|null>}
 */
export async function jobBacklogs() {
  return remember(
    'jobBacklogs',
    // Widened with `failingFeeds` above and for the same reason. This one is
    // the more likely of the two to need it: it measured 11–27.9s, so its own
    // background refresh does not reliably fit inside CHART_TIMEOUT_MS and the
    // entry cannot count on renewing itself.
    { ttlMs: JOBS_TTL_MS, maxStaleMs: CHART_MAX_STALE_MS, timeoutMs: CHART_TIMEOUT_MS, fallback: null },
    () => q.jobBacklogs(db()),
  );
}

/**
 * One panel's read, which must not be able to take a whole status page down.
 *
 * /crawlstats and /api/crawlstats each run their reads in a single
 * `Promise.all`. Most of them come from this module and so already survive a
 * failure, because `remember` returns its fallback rather than throwing. The
 * rest go straight to the database — and any one of those exceeding the
 * client's 30s deadline rejected the whole `Promise.all`, so the page rendered
 * nothing and the endpoint answered nothing.
 *
 * That is the wrong way round for these two in particular. They exist to be
 * read when the crawler is in trouble, and "the crawler is in trouble" is
 * exactly when a read against a contended database times out — so they failed
 * at the only moment anyone wanted them, and said nothing about why.
 *
 * The caller supplies the value its panel already renders for "nothing here":
 * an empty list where a list is mapped, `{}` for the activity map that is
 * indexed by event name, and `null` — never `0` — for a queue depth, because
 * "0 waiting" reads as "all caught up" and would be a lie about a number we
 * failed to read. Same distinction `jobBacklogs` above documents.
 *
 * Deliberately not a cache. These are the fresh half of the page: a stale "last
 * ran at" is how a dead worker looks alive, so missing beats wrong here.
 *
 * Bounded as well as caught: see `PANEL_TIMEOUT_MS`. Catching a rejection is
 * only half of "one bad read must not take the page", because a read that never
 * answers never rejects either.
 *
 * @template T
 * @param {Promise<T>} read
 * @param {T} fallback
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
export function panel(read, fallback, ms = PANEL_TIMEOUT_MS) {
  return Promise.race([
    read.catch(() => fallback),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms);
      // Node keeps the process alive for a pending timer; this one must never be
      // the reason a serverless invocation lingers after the page is sent.
      timer.unref?.();
    }),
  ]);
}

/**
 * Run `read`, rejecting if it has not answered within `ms`.
 *
 * `remember` has one of these of its own, private to that module because a
 * cache that can hang is not a cache. This is the same shape for the one read
 * on this page that deliberately does *not* go through the cache, so it is
 * duplicated rather than exported: the two bounds are set for different reasons
 * and should be free to move apart.
 *
 * The underlying read keeps running — there is no cancellation in the libSQL
 * client — but nobody is waiting on it any more, which is the half that decides
 * whether the reader gets a page.
 *
 * @template T
 * @param {() => Promise<T>} read
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withDeadline(read, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`crawlStats timed out after ${ms}ms`)), ms);
    read().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
