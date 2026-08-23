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
 */
const CHART_MAX_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Shorter than the client's own 30s deadline, so a read that is going to hang
 * gives the page back before the browser gives up on it.
 */
const CHART_TIMEOUT_MS = 20 * 1000;

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
      timeoutMs: CHART_TIMEOUT_MS,
      fallback: null,
    },
    () => q.categoryStats(db(), GROWTH_DAYS),
  );

  return value ?? { total: 0, days: [], categories: [] };
}

/**
 * How long the liveness numbers are trusted.
 *
 * Ten seconds against a page that refreshes every fifteen, so a reader is never
 * looking at anything meaningfully older than the last refresh, and a burst of
 * concurrent readers costs one read rather than one each.
 */
const STATS_TTL_MS = 10 * 1000;

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
      // Minutes, not hours: these are the numbers that must not drift far, and
      // if they cannot be read at all the page should say so by other means.
      maxStaleMs: 2 * 60 * 1000,
      timeoutMs: CHART_TIMEOUT_MS,
      fallback: null,
    },
    () => q.crawlStats(db()),
  );

  if (!stats) return await q.crawlStats(db());

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
    { ttlMs: 60 * 1000, maxStaleMs: 6 * 60 * 60 * 1000, timeoutMs: CHART_TIMEOUT_MS, fallback: [] },
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

/** How long a job-board read is trusted. */
const JOBS_TTL_MS = 60 * 1000;

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
    { ttlMs: JOBS_TTL_MS, maxStaleMs: 6 * 60 * 60 * 1000, timeoutMs: CHART_TIMEOUT_MS, fallback: null },
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
 * @template T
 * @param {Promise<T>} read
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export function panel(read, fallback) {
  return read.catch(() => fallback);
}
