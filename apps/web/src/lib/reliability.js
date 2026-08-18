import { q } from '@rssamplifier/db';

import { db } from './db.js';

/**
 * The measured half of the terms page, cached and never allowed to fail.
 *
 * Same bargain as `categoryStats` in ./crawlstats.js: served stale while it
 * refreshes behind the request, because these numbers move at the speed of a
 * crawl cycle and nobody reading a terms page needs them to the second. And
 * caught rather than thrown, because a page whose job is to describe how
 * reliable the service is must not be the page that 500s — the poller owns
 * migration and the web service does not wait for it, so there is a window on
 * every deploy where the newest column is not there yet.
 */

/** How long a reliability read is trusted. */
const TTL_MS = 5 * 60 * 1000;

/** @type {{ at: number, value: Awaited<ReturnType<typeof q.reliability>> }|null} */
let cache = null;

/** Guards against a slow refresh being started once per concurrent request. */
let refreshing = false;

/**
 * @returns {Promise<Awaited<ReturnType<typeof q.reliability>>|null>}
 */
export async function reliability() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  if (cache) {
    if (!refreshing) {
      refreshing = true;
      refresh().finally(() => {
        refreshing = false;
      });
    }
    return cache.value;
  }

  return refresh();
}

/**
 * @returns {Promise<Awaited<ReturnType<typeof q.reliability>>|null>}
 */
async function refresh() {
  try {
    const value = await q.reliability(db());
    cache = { at: Date.now(), value };
    return value;
  } catch {
    // Null rather than zeroes: the page says "we cannot show this right now",
    // which is true, instead of publishing a fabricated 0% availability that
    // would be worse than saying nothing at all.
    return null;
  }
}
