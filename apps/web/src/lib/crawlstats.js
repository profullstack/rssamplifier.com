import { q } from '@rssamplifier/db';

import { db } from './db.js';

/**
 * The slow half of /crawlstats, cached in the process.
 *
 * The status numbers on that page have to be current to the second — a stalled
 * crawler that reads "healthy" because the answer came from a cache is the one
 * failure the page exists to catch. The breakdowns below are the opposite kind
 * of number: a directory of 48k feeds does not change shape between two
 * fifteen-second refreshes, and recomputing a group-by over every feed on each
 * one bills a full table scan for an answer that is the same all morning.
 *
 * So they are cached, separately, for as long as each is actually still true:
 *
 * - the hourly rollup is a handful of rows and moves within the hour, so a
 *   minute is plenty of staleness to accept for it;
 * - the category breakdown is two scans of `feeds` and moves at the speed of
 *   the crawler finding new blogs, which is nothing like every fifteen seconds.
 *
 * Per process and dying with it, matching `popularLanguages` in ./languages.js:
 * a deploy or a restart is exactly when it is worth looking again.
 */

/** How long an hourly rollup read is trusted. */
const HISTORY_TTL_MS = 60 * 1000;

/** How long a category breakdown is trusted. */
const CATEGORY_TTL_MS = 5 * 60 * 1000;

/** How much history the charts draw. */
export const HISTORY_HOURS = 24;
export const GROWTH_DAYS = 30;

/** @type {{ at: number, value: Awaited<ReturnType<typeof q.indexingHistory>> }|null} */
let historyCache = null;

/** @type {{ at: number, value: Awaited<ReturnType<typeof q.categoryStats>> }|null} */
let categoryCache = null;

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
  if (historyCache && Date.now() - historyCache.at < HISTORY_TTL_MS) return historyCache.value;

  try {
    const value = await q.indexingHistory(db(), HISTORY_HOURS);
    historyCache = { at: Date.now(), value };
    return value;
  } catch {
    return [];
  }
}

/**
 * The directory by category, with each category's growth curve.
 *
 * Same bargain as above: a status page missing its breakdown is worth more than
 * a status page that 500s.
 *
 * @returns {Promise<Awaited<ReturnType<typeof q.categoryStats>>>}
 */
export async function categoryStats() {
  const fresh = categoryCache && Date.now() - categoryCache.at < CATEGORY_TTL_MS;
  if (fresh) return categoryCache.value;

  // Expired but present: hand back the old answer and refresh behind it.
  //
  // This read is the slowest thing left on the page — 6.1 seconds against
  // production, because it wants five columns per feed (category, status,
  // created_at, last_success_at, item_count) and three of them are rewritten on
  // every crawl, so an index wide enough to cover it would cost more on the
  // write path than the read is worth. A plain TTL therefore does not make the
  // page fast, it makes one reader in every five minutes wait six seconds for a
  // breakdown that was already almost right.
  //
  // Serving stale while revalidating is the honest trade for this particular
  // number: it is a shape-of-the-directory figure that moves at the speed of
  // the crawler finding new blogs, so five minutes and five minutes plus six
  // seconds are the same answer.
  if (categoryCache) {
    if (!categoryRefreshing) {
      categoryRefreshing = true;
      refreshCategories().finally(() => {
        categoryRefreshing = false;
      });
    }
    return categoryCache.value;
  }

  // Nothing cached at all — the first request after a deploy has to wait.
  return (await refreshCategories()) ?? { total: 0, days: [], categories: [] };
}

/** Guards against a slow refresh being started once per concurrent request. */
let categoryRefreshing = false;

/**
 * Re-read the breakdown and store it, returning null rather than throwing.
 *
 * @returns {Promise<Awaited<ReturnType<typeof q.categoryStats>>|null>}
 */
async function refreshCategories() {
  try {
    const value = await q.categoryStats(db(), GROWTH_DAYS);
    categoryCache = { at: Date.now(), value };
    return value;
  } catch {
    // A failed refresh leaves the previous answer in place and is retried on
    // the next request, which is the whole point of keeping the old value.
    return null;
  }
}
