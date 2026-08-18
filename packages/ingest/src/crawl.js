import { resolveFeed, scrapeFeed, feedTopics } from '@rssamplifier/feed';
import { q, authors } from '@rssamplifier/db';

import { storeCredits } from './enrich.js';

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
 * @param {{ id: string, feed_url: string, error_count?: number, fetch_interval_minutes?: number, source_kind?: string, item_count?: number }} feed
 * @param {{ resolve?: typeof resolveFeed, scrape?: typeof scrapeFeed }} [opts]
 *   injected by the tests, the way `enrichFeedAuthors` takes its fetcher: the
 *   guards in the fetch layer refuse loopback addresses, so a crawl cannot be
 *   exercised end to end against a local server without this seam.
 * @returns {Promise<{ ok: boolean, newItems: number, error?: string }>}
 */
export async function crawlFeed(db, feed, opts = {}) {
  const id = String(feed.id);
  const scraped = feed.source_kind === 'scraped';
  const resolved = scraped
    ? await (opts.scrape ?? scrapeFeed)(String(feed.feed_url))
    : await (opts.resolve ?? resolveFeed)(String(feed.feed_url));

  if (!resolved.ok) {
    const errorCount = Number(feed.error_count ?? 0) + 1;
    await q.markCrawlFailure(db, id, resolved.error, errorCount, backoffMinutes(errorCount));
    return { ok: false, newItems: 0, error: resolved.error };
  }

  // One write transaction for the items *and* the feed row, with no `count(*)`
  // round trip between them — see `storeCrawl`. Against this database an empty
  // write transaction measured 29–118 seconds while a read measured 100ms, so
  // the only number that moves the crawler is how many write transactions a
  // feed costs. The interval ladder that used to be applied here by
  // `nextIntervalMinutes` is applied inside that same statement instead.
  //
  // `sent` is the change in the stored total, which is the only honest way to
  // count what a crawl added: every crawl re-offers the publisher's whole
  // document, so "items the document contained" is never zero. Reading it as
  // "new items" is what once kept `nextIntervalMinutes` pinned to its floor and
  // had **every feed in the directory re-crawled hourly for ever**, with the
  // backoff ladder never once engaging.
  const { stored: sent } = await q.storeCrawl(
    db,
    id,
    resolved.feed.items,
    resolved.feed,
    Number(feed.item_count ?? 0),
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

  // Whoever the document names, stored for free: the feed is already parsed
  // and the credits came out of it with it. The links half of enrichment costs
  // requests and lives in enrichDue instead.
  //
  // Guarded for the same reason topics are, on the same condition, and it is
  // the more expensive of the two omissions. "Stored for free" was true of the
  // parsing and false of the storing: `storeCredits` issued **three write
  // transactions on every crawl** — an `update authors` coalescing every column
  // onto the value already in it, an insert into feed_authors, and one into
  // author_links — and on a re-crawl of an unchanged feed all three wrote the
  // answer that was already there. Counted by instrumenting a crawl against a
  // local database: 4 write transactions, 3 of them pointless.
  //
  // Against this database a write transaction costs ~370ms and they serialize
  // per database, so those three were most of the crawler's ceiling. A byline
  // cannot have changed if the feed published nothing, which is exactly the
  // argument the topics block above already makes about its text.
  //
  // Guarded for one more reason too. A byline that fails to store is a missing
  // name; a byline that fails the *crawl* backs the feed off and eventually
  // marks a healthy blog dead, which is a far worse trade.
  let people = 0;
  try {
    if (sent > 0 || !(await authors.feedHasAuthors(db, id))) {
      const stored = await storeCredits(db, { id, feed_url: String(feed.feed_url) }, resolved.feed.credits ?? []);
      people = stored.people;
    }
  } catch (err) {
    return { ok: true, newItems: sent, topics, authorError: String(err?.message ?? err) };
  }

  return { ok: true, newItems: sent, topics, people };
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
    // Unparseable URLs get their own bucket, keyed by the raw string; resolveFeed
    // rejects them individually rather than blocking a real host's queue.
    const host = hostOf(feed);
    const queue = byHost.get(host);
    if (queue) queue.push(feed);
    else byHost.set(host, [feed]);
  }

  return [...byHost.values()];
}

/**
 * How many feeds from any one host may enter a single batch.
 *
 * The number that decides whether the worker pool is busy or watching one
 * worker grind. A host's feeds are crawled strictly in series — that is the
 * politeness guarantee and it is not negotiable — so a batch that is half one
 * host has a floor on its wall-clock that no amount of concurrency can lift.
 *
 * Eight is a little above what a single host can absorb inside one 60-second
 * tick anyway (a crawl of a live feed averages ~9s against a network database),
 * so this costs a well-behaved host nothing and stops a large one from renting
 * the whole batch.
 */
export const PER_HOST_DEFAULT = 8;

/**
 * How many rows to read before choosing a batch from them.
 *
 * The cap above can only spread a batch across the hosts it was offered, so the
 * selection has to see more rows than it will use. Three times over is enough
 * for the observed shape and is a handful of extra kilobytes on one indexed
 * read.
 */
const OVERREAD = 3;

/**
 * Choose a batch that is spread across hosts rather than dominated by one.
 *
 * This is the fix for the thing that actually limited the crawler. `crawlDue`
 * gives each host's feeds to a single worker, in series, so the batch takes as
 * long as its **largest host queue** rather than as long as its average one —
 * and this directory is extremely skewed: in a 500-feed sample, 164 feeds were
 * on `wavlake.com` and 76 on `archive.org`, so half the directory lives on two
 * hosts. A 300-feed batch handed one worker a hundred feeds to walk through
 * while the other twenty-three finished single-feed queues in seconds and
 * exited. Measured throughput sat at about a third of what the same pool
 * managed on a diverse batch.
 *
 * Two passes, and the second one is what makes this safe. The first takes up to
 * `perHost` from each host in the order they came due. If that has not filled
 * the batch — because the due set genuinely *is* one host, which happens when a
 * bulk import comes due together — the second pass fills the rest in due order
 * with the cap lifted. So a spread batch is chosen whenever the rows allow one,
 * and a monolithic due set is still crawled at exactly the rate it was before
 * rather than being throttled to `perHost`.
 *
 * @param {object[]} feeds candidate rows, already in due order
 * @param {number} batchSize how many to return at most
 * @param {number} [perHost]
 * @returns {object[]}
 */
export function spreadHosts(feeds, batchSize, perHost = PER_HOST_DEFAULT) {
  if (batchSize <= 0) return [];

  const taken = [];
  const counts = new Map();
  const held = [];

  for (const feed of feeds) {
    if (taken.length >= batchSize) break;

    const host = hostOf(feed);
    const n = counts.get(host) ?? 0;

    if (n < perHost) {
      counts.set(host, n + 1);
      taken.push(feed);
    } else {
      held.push(feed);
    }
  }

  // Under-filled only because the cap held rows back. Better a batch that
  // repeats a host than a batch that is mostly empty.
  for (const feed of held) {
    if (taken.length >= batchSize) break;
    taken.push(feed);
  }

  return taken;
}

/**
 * The host a feed's URL names, or the raw URL when it will not parse.
 *
 * @param {{ feed_url: unknown }} feed
 * @returns {string}
 */
function hostOf(feed) {
  try {
    return new URL(String(feed.feed_url)).hostname;
  } catch {
    return String(feed.feed_url);
  }
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
 * Two things keep that concurrency real rather than nominal, and both exist
 * because measurement said so:
 *
 *   * the batch is **spread across hosts** before it is run (see `spreadHosts`),
 *     because half this directory lives on two domains and an unspread batch
 *     gave one worker a hundred feeds while the rest went home;
 *   * the queues are started **longest first**, which is the standard way to
 *     keep the tail short: a five-feed queue picked up last is five feeds of
 *     wall-clock added to the batch, and picked up first it is absorbed by the
 *     workers that would otherwise be idle at the end.
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
 * @param {{ perHost?: number }} [opts]
 * @returns {Promise<{ crawled: number, failed: number, items: number, hosts: number }>} items being posts stored, not posts seen
 */
export async function crawlDue(db, batchSize = 25, concurrency = 8, onEvent = null, opts = {}) {
  const perHost = Number(opts.perHost) > 0 ? Number(opts.perHost) : PER_HOST_DEFAULT;

  // Read more than will be used, so the spread has something to choose from.
  // One indexed read either way; the extra rows are a few kilobytes.
  const pool = await q.dueFeeds(db, batchSize * OVERREAD);
  if (pool.length === 0) return { crawled: 0, failed: 0, items: 0, hosts: 0 };

  const due = spreadHosts(pool, batchSize, perHost);

  // Longest queue first. Whichever host is heaviest in this batch is the one
  // that decides when the batch ends, so it must start at the beginning of it.
  const queues = groupByHost(due).sort((a, b) => b.length - a.length);
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

  // `hosts` is what says whether the spread is working: a batch of 300 feeds
  // across 4 hosts cannot go faster than its biggest queue however many workers
  // are pointed at it, and the number is otherwise invisible from outside.
  return { crawled, failed, items, hosts: queues.length };
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
