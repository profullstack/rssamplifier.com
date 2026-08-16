import { resolveFeed } from '@rssamplifier/feed';
import { q } from '@rssamplifier/db';

/** Backoff ladder in minutes, indexed by consecutive error count. */
const BACKOFF = [60, 180, 360, 720, 1440];
const MAX_INTERVAL = 10_080; // one week

/** Shortest gap between crawls of the same feed. */
const MIN_INTERVAL = 60;
/** Longest gap for a feed that is merely quiet rather than broken. */
const MAX_QUIET_INTERVAL = 1440; // one day

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
 * How long to wait before re-crawling a feed that answered.
 *
 * Re-fetching every feed hourly is affordable for a hundred blogs and not for
 * fifty thousand: at one crawl per feed per hour a 47k directory needs 783
 * fetches a minute, forever. Most of the small web posts monthly, so a feed
 * that produced nothing new doubles its gap up to a day, and one that did
 * publish drops straight back to hourly. The directory ends up spending its
 * request budget on the blogs that are actually active.
 *
 * @param {number} newItems items stored by the crawl that just ran
 * @param {number} currentMinutes the feed's existing interval
 * @returns {number} minutes
 */
export function nextIntervalMinutes(newItems, currentMinutes = MIN_INTERVAL) {
  if (newItems > 0) return MIN_INTERVAL;
  const current = Number(currentMinutes) || MIN_INTERVAL;
  return Math.min(Math.max(current, MIN_INTERVAL) * 2, MAX_QUIET_INTERVAL);
}

/**
 * Re-crawl one feed and store anything new.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ id: string, feed_url: string, error_count?: number, fetch_interval_minutes?: number }} feed
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
  await q.markCrawlSuccess(
    db,
    id,
    resolved.feed,
    total,
    nextIntervalMinutes(sent, feed.fetch_interval_minutes),
  );

  return { ok: true, newItems: sent };
}

/**
 * Group feeds by the host they live on, preserving order within each host.
 *
 * @param {Array<{ feed_url: string }>} feeds
 * @returns {Array<Array<object>>} one queue per host
 */
export function groupByHost(feeds) {
  const byHost = new Map();

  for (const feed of feeds) {
    let host;
    try {
      host = new URL(String(feed.feed_url)).hostname;
    } catch {
      // Unparseable URLs get their own bucket; resolveFeed will reject them
      // individually rather than blocking a real host's queue.
      host = String(feed.feed_url);
    }
    const queue = byHost.get(host);
    if (queue) queue.push(feed);
    else byHost.set(host, [feed]);
  }

  return [...byHost.values()];
}

/**
 * Crawl every feed whose next_fetch_at has passed.
 *
 * Hosts are crawled in parallel and each host's own feeds strictly in series.
 * The old version was sequential across the whole batch, which is polite but
 * caps the crawler at roughly one feed per second — about a month per pass over
 * a directory this size. Because the batch spans thousands of distinct
 * domains, running hosts concurrently buys the throughput without ever sending
 * two overlapping requests to the same server.
 *
 * @param {import('@libsql/client').Client} db
 * @param {number} [batchSize]
 * @param {number} [concurrency] hosts crawled at once
 * @returns {Promise<{ crawled: number, failed: number }>}
 */
export async function crawlDue(db, batchSize = 25, concurrency = 8) {
  const due = await q.dueFeeds(db, batchSize);
  if (due.length === 0) return { crawled: 0, failed: 0 };

  const queues = groupByHost(due);
  let crawled = 0;
  let failed = 0;
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= queues.length) return;

      for (const feed of queues[index]) {
        // One feed that throws — a write that times out, a URL that breaks the
        // parser — must not reject the whole batch and take the other workers'
        // completed crawls down with it.
        try {
          const res = await crawlFeed(db, feed);
          if (res.ok) crawled += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
    }
  };

  const workers = Math.max(1, Math.min(concurrency, queues.length));
  await Promise.all(Array.from({ length: workers }, worker));

  return { crawled, failed };
}
