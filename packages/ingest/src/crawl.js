import { resolveFeed, scrapeFeed, feedTopics } from '@rssamplifier/feed';
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
 * Recompute one feed's topics from what is stored for it.
 *
 * Read back out of the database rather than taken from the document just
 * fetched: a feed only carries its most recent items, so extracting from the
 * response would narrow a blog's topics to whatever it published this month and
 * widen them again next month. The stored items are everything we have ever
 * seen it publish.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} feedId
 * @param {{ title?: string, description?: string, categories?: string[] }} feed
 * @returns {Promise<number>} topics stored
 */
export async function refreshFeedKeywords(db, feedId, feed = {}) {
  const items = await q.itemsForKeywords(db, feedId);

  const blocks = [];
  if (feed.title) blocks.push(String(feed.title));
  if (feed.description) blocks.push(String(feed.description));

  const categories = Array.isArray(feed.categories) ? [...feed.categories] : [];

  for (const item of items) {
    if (item.title) blocks.push(String(item.title));
    if (item.summary) blocks.push(String(item.summary));

    // Stored as JSON because SQLite has no array type; a row written before the
    // column existed, or by anything that wrote it badly, must not take the
    // crawl down with it.
    try {
      const parsed = JSON.parse(String(item.categories ?? '[]'));
      if (Array.isArray(parsed)) categories.push(...parsed.map((c) => String(c)));
    } catch {
      // Not JSON, so there are no categories on this item. Nothing to report:
      // the topics of the other items are unaffected.
    }
  }

  const topics = feedTopics({ blocks, categories });
  await q.replaceFeedKeywords(db, feedId, topics);
  return topics.length;
}

/**
 * Re-crawl one feed and store anything new.
 *
 * A scraped source is re-scraped rather than re-resolved. Its feed_url is a
 * page of prose, so parsing it as a feed fails; and sending it back through
 * resolveFeed would also spend nine speculative requests per crawl guessing at
 * feed paths that were already ruled out when it was submitted.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ id: string, feed_url: string, error_count?: number, fetch_interval_minutes?: number, source_kind?: string }} feed
 * @returns {Promise<{ ok: boolean, newItems: number, error?: string }>}
 */
export async function crawlFeed(db, feed) {
  const id = String(feed.id);
  const scraped = feed.source_kind === 'scraped';
  const resolved = scraped
    ? await scrapeFeed(String(feed.feed_url))
    : await resolveFeed(String(feed.feed_url));

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

  // Only when the feed actually published something, or when it has no topics
  // yet. Re-extracting on every crawl would rewrite twenty-five rows per feed
  // per hour across the whole directory to arrive at the same answer — the text
  // cannot have changed if nothing was added to it.
  //
  // Topics are a browsing aid, so failing to extract them must not turn a crawl
  // that stored its items into a failure — that would back the feed off and
  // eventually mark a perfectly healthy blog dead.
  let topics = 0;
  try {
    if (sent > 0 || (await q.countFeedKeywords(db, id)) === 0) {
      topics = await refreshFeedKeywords(db, id, resolved.feed);
    }
  } catch (err) {
    return { ok: true, newItems: sent, topics: 0, topicError: String(err?.message ?? err) };
  }

  return { ok: true, newItems: sent, topics };
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
 * `onEvent` is called once per feed as it settles, which is what makes a live
 * log possible: the return value only arrives when the whole batch is done, and
 * a batch is the thing somebody watching wants to see progress through. It is
 * called synchronously with a plain object and is never awaited — a slow or
 * throwing listener must not hold up or break the crawl.
 *
 * @param {import('@libsql/client').Client} db
 * @param {number} [batchSize]
 * @param {number} [concurrency] hosts crawled at once
 * @param {((event: { at: string, event: 'feed', status: 'ok'|'error', subject: string, slug: string|null, amount: number|null, detail: string|null, ms: number }) => void)|null} [onEvent]
 * @returns {Promise<{ crawled: number, failed: number, items: number }>} items being posts stored, not posts seen
 */
export async function crawlDue(db, batchSize = 25, concurrency = 8, onEvent = null) {
  const due = await q.dueFeeds(db, batchSize);
  if (due.length === 0) return { crawled: 0, failed: 0, items: 0 };

  const queues = groupByHost(due);
  let crawled = 0;
  let failed = 0;
  // Posts actually stored this batch. The caller rolls this into the hourly
  // record on /crawlstats, and counting them here is free — every crawl already
  // reports what it added, and the alternative is counting feed_items rows by
  // hour, which is a scan of the largest table in the database.
  let items = 0;
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= queues.length) return;

      for (const feed of queues[index]) {
        const started = Date.now();

        // One feed that throws — a write that times out, a URL that breaks the
        // parser — must not reject the whole batch and take the other workers'
        // completed crawls down with it.
        try {
          const res = await crawlFeed(db, feed);
          if (res.ok) {
            crawled += 1;
            items += Number(res.newItems ?? 0);
          } else failed += 1;

          report(onEvent, feed, started, {
            ok: res.ok,
            amount: res.ok ? Number(res.newItems ?? 0) : null,
            detail: res.ok ? null : (res.error ?? 'unknown'),
          });
        } catch (err) {
          failed += 1;
          report(onEvent, feed, started, {
            ok: false,
            amount: null,
            detail: String(err?.message ?? err),
          });
        }
      }
    }
  };

  const workers = Math.max(1, Math.min(concurrency, queues.length));
  await Promise.all(Array.from({ length: workers }, worker));

  return { crawled, failed, items };
}

/**
 * Hand one settled feed to the log listener, if there is one.
 *
 * Wrapped because the listener belongs to the caller: the crawl's job is to
 * crawl, and a logger that throws is a logging bug, not a reason to lose a
 * batch's worth of fetches.
 *
 * @param {((event: object) => void)|null} onEvent
 * @param {{ id: string, feed_url: string, slug?: unknown, title?: unknown }} feed
 * @param {number} started epoch ms
 * @param {{ ok: boolean, amount: number|null, detail: string|null }} outcome
 */
function report(onEvent, feed, started, outcome) {
  if (typeof onEvent !== 'function') return;

  try {
    onEvent({
      at: new Date().toISOString(),
      event: 'feed',
      status: outcome.ok ? 'ok' : 'error',
      // The blog's name when we have one, and the URL that was actually fetched
      // otherwise — a feed crawled before its first successful parse has no
      // title, and those are exactly the lines somebody is watching for.
      subject: String(feed.title || feed.feed_url),
      slug: feed.slug == null ? null : String(feed.slug),
      amount: outcome.amount,
      detail: outcome.detail,
      ms: Date.now() - started,
    });
  } catch {
    // A broken listener loses its line and nothing else.
  }
}
