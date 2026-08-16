import { resolveFeed } from '@rssamplifier/feed';
import { q } from '@rssamplifier/db';

/** Backoff ladder in minutes, indexed by consecutive error count. */
const BACKOFF = [60, 180, 360, 720, 1440];
const MAX_INTERVAL = 10_080; // one week

/**
 * How long to wait before the next attempt on a feed.
 *
 * A feed that keeps failing is retried progressively less often rather than
 * dropped, so a blog that goes down for a week comes back on its own.
 *
 * @param {number} errorCount consecutive failures, including the current one
 * @returns {number} minutes
 */
export function backoffMinutes(errorCount) {
  if (errorCount <= 0) return 60;
  return Math.min(BACKOFF[Math.min(errorCount - 1, BACKOFF.length - 1)], MAX_INTERVAL);
}

/**
 * Re-crawl one feed and store anything new.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ id: string, feed_url: string, error_count?: number }} feed
 * @returns {Promise<{ ok: boolean, newItems: number, error?: string }>}
 */
export async function crawlFeed(db, feed) {
  const id = String(feed.id);
  const resolved = await resolveFeed(String(feed.feed_url));

  if (!resolved.ok) {
    const errorCount = Number(feed.error_count ?? 0) + 1;
    await q.markCrawlFailure(db, id, resolved.error, errorCount, backoffMinutes(errorCount));
    return { ok: false, newItems: 0, error: resolved.error };
  }

  const sent = await q.upsertItems(db, id, resolved.feed.items);
  const total = await q.countItems(db, id);
  await q.markCrawlSuccess(db, id, resolved.feed, total);

  return { ok: true, newItems: sent };
}

/**
 * Crawl every feed whose next_fetch_at has passed.
 *
 * @param {import('@libsql/client').Client} db
 * @param {number} [batchSize]
 * @returns {Promise<{ crawled: number, failed: number }>}
 */
export async function crawlDue(db, batchSize = 25) {
  const due = await q.dueFeeds(db, batchSize);
  if (due.length === 0) return { crawled: 0, failed: 0 };

  let crawled = 0;
  let failed = 0;

  // Sequential: these are requests to other people's servers and the daemon has
  // no deadline worth being rude for.
  for (const feed of due) {
    const res = await crawlFeed(db, feed);
    if (res.ok) crawled += 1;
    else failed += 1;
  }

  return { crawled, failed };
}
