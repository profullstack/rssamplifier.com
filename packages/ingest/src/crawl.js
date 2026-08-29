import { resolveFeed, scrapeFeed, feedTopics } from '@rssamplifier/feed';
import { q, authors } from '@rssamplifier/db';
import { fetchXSource } from '@rssamplifier/social';

import { prepareCredits } from './enrich.js';
import {
  intervalFromDates,
  intervalFromChanges,
  nextInterval,
  newestPublished,
  contentSignature,
  recordChange,
  neverSooner,
  MIN_INTERVAL as FLOOR_DEFAULT,
  SOCIAL_MIN_INTERVAL,
} from './cadence.js';

/** Backoff ladder in minutes, indexed by consecutive error count. */
const BACKOFF = [60, 180, 360, 720, 1440];
const MAX_INTERVAL = 10_080; // one week

/** Shortest gap between crawls of the same feed. */
const MIN_INTERVAL = 60;
/** Longest gap for a feed that is merely quiet rather than broken. */
const MAX_QUIET_INTERVAL = 1440; // one day

// Topics and bylines are useful projections, not part of deciding whether a
// feed is healthy. A large first-crawl catch-up can pause them so its scarce
// database writes are spent on feeds and posts; feeds with no projection are
// picked up once this is switched back on.
const AUXILIARY_WRITES = !['0', 'false'].includes(
  String(process.env['CRAWL_AUXILIARY_WRITES'] ?? '').toLowerCase(),
);

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

/** How long to wait after a throttle that named no interval of its own. */
const THROTTLE_DEFAULT = 30;

/**
 * How long to wait after being throttled.
 *
 * The server's own `Retry-After` wins, because it is the only party that knows
 * when its limit resets. Floored at a minute so a `Retry-After: 0` cannot spin,
 * and capped at a day so a misread date cannot mothball the feed.
 *
 * Deliberately much shorter than the error ladder: this feed is healthy and we
 * want it back soon. It is the *rate* that has to come down, and lengthening one
 * feed's interval is the wrong instrument for that -- see POLL_CONCURRENCY.
 *
 * @param {number|null|undefined} retryAfter seconds the server asked for
 * @returns {number} minutes
 */
export function throttleMinutes(retryAfter) {
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return THROTTLE_DEFAULT;
  return Math.min(Math.max(1, Math.ceil(seconds / 60)), 1440);
}

/**
 * How long to wait before re-crawling a feed whose document carried no dates.
 *
 * This is now only the fallback half of the schedule — see cadence.js, which
 * decides from the feed's own publishing rhythm whenever the document gives it
 * two believable dates to work with, and which is what the crawl actually
 * calls. This remains as the answer for an undated feed, and it is deliberately
 * the *old* answer, ceiling included: without dates there is no evidence that a
 * quiet feed has been abandoned, only that it is quiet, and a 90-day gap is too
 * strong a conclusion to draw from no data at all.
 *
 * Delegated rather than reimplemented so there is one statement of the policy.
 * The same ladder also exists in SQL inside `storeCrawl`, because this branch
 * depends on how many posts the crawl stored and that is not known until the
 * write has run; the tests pin the two together.
 *
 * @param {number} newItems items stored by the crawl that just ran
 * @param {number} currentMinutes the feed's existing interval
 * @returns {number} minutes
 */
export function nextIntervalMinutes(newItems, currentMinutes = MIN_INTERVAL) {
  return nextInterval({ items: [], newItems, currentMinutes });
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
  const topics = topicsFrom(feed, items);
  await q.replaceFeedKeywords(db, feedId, topics);
  return topics.length;
}

/**
 * A feed's topics, from its own metadata and everything it has published.
 *
 * Pure, and separated from the read on purpose: `crawlFeed` reads the stored
 * items *before* it writes the new ones so that the topics can go into the same
 * transaction as everything else. Given the stored items and the document, this
 * produces the same answer either way round.
 *
 * Both sources are used because neither is sufficient. The document alone would
 * narrow a blog's topics to whatever it published this month, since a feed only
 * carries its recent items; the stored items alone would miss the post that has
 * just arrived and is the reason we are recomputing at all.
 *
 * @param {{ title?: string, description?: string, categories?: string[], items?: object[] }} feed
 * @param {object[]} [storedItems] rows from `itemsForKeywords`
 * @returns {Array<{ slug: string, keyword: string, words?: number, count?: number, source?: string }>}
 */
export function topicsFrom(feed = {}, storedItems = []) {
  const blocks = [];
  if (feed.title) blocks.push(String(feed.title));
  if (feed.description) blocks.push(String(feed.description));

  const categories = Array.isArray(feed.categories) ? [...feed.categories] : [];

  for (const item of storedItems ?? []) {
    if (item.title) blocks.push(String(item.title));
    if (item.summary) blocks.push(String(item.summary));

    // Stored as JSON because SQLite has no array type; a row written before the
    // column existed, or by anything that wrote it badly, must not take the
    // crawl down with it.
    try {
      const parsed = JSON.parse(String(item.categories ?? '[]'));
      if (Array.isArray(parsed)) categories.push(...parsed.map((c) => String(c)));
    } catch {
      // Not JSON, so there are no categories on this item. The topics of the
      // other items are unaffected.
    }
  }

  // The document's own items, which are the ones not yet stored. Their
  // categories are already arrays rather than JSON text.
  for (const item of feed.items ?? []) {
    if (item?.title) blocks.push(String(item.title));
    if (item?.summary) blocks.push(String(item.summary));
    if (Array.isArray(item?.categories)) categories.push(...item.categories.map((c) => String(c)));
  }

  return feedTopics({ blocks, categories });
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
/**
 * Collect an X source, or decline politely if there is nothing to collect with.
 *
 * The declining is the point. The X runtime is built once at boot by whoever
 * runs the crawl, and a process that has not built one — a test, a script, a
 * deploy where `X_ENABLED` is off — must not treat that as the *source*
 * failing. `markCrawlFailure` retires a feed after ten consecutive failures, so
 * a poller started without X configured would quietly kill every X source in
 * the directory over a few hours and leave no trace of why.
 *
 * So it returns a throttle instead: come back in an hour, change nothing about
 * the feed's health. That is also the correct behaviour for the kill switch of
 * §42 — turning X off must not damage what has already been collected, and the
 * public routes go on serving it (§40, AC-5).
 *
 * @param {object} feed
 * @param {{ x?: Function, xRuntime?: object }} opts
 */
async function collectSocial(feed, opts) {
  const runtime = opts.xRuntime ?? null;
  if (!runtime) {
    return { ok: false, throttled: true, retryAfter: 3600, error: 'x-runtime-unavailable' };
  }

  return (opts.x ?? fetchXSource)(feed, { runtime });
}

export async function crawlFeed(db, feed, opts = {}) {
  const id = String(feed.id);
  const scraped = feed.source_kind === 'scraped';

  // The third way in. A feed is fetched, a scraped source is read off a page,
  // and a social source is collected through a provider — three methods, one
  // return shape, and everything past this point is identical for all three.
  // That is what keeps X out of the rest of the pipeline entirely: dedupe,
  // interval learning, keyword extraction, credits, FTS and syndication never
  // learn that it exists (§30, AC-8).
  const social = feed.social_network === 'x' ? 'x' : null;

  // A provider-backed source polls on a five-minute floor rather than an hour's
  // — see SOCIAL_MIN_INTERVAL. The floor is passed to every scheduling call
  // below rather than read from a global, so this row's cadence is decided here
  // and nowhere else.
  const floor = social ? SOCIAL_MIN_INTERVAL : FLOOR_DEFAULT;

  // What the server told us last time, sent back so it can answer "still the
  // same" without sending the document again. Scraped sources are excluded: what
  // is fetched there is a page of prose whose validators describe the page, and
  // a marketing site that has not changed its header is not evidence that the
  // posts extracted from it have not.
  const conditional =
    scraped || social
      ? {}
      : { etag: feed.http_etag ?? null, lastModified: feed.http_last_modified ?? null };

  const resolved = social
    ? await collectSocial(feed, opts)
    : scraped
      ? await (opts.scrape ?? scrapeFeed)(String(feed.feed_url))
      : await (opts.resolve ?? resolveFeed)(String(feed.feed_url), conditional);

  // The publisher says nothing has changed. This is the cheapest and the most
  // trustworthy answer the crawler can get: no body was sent, nothing is parsed,
  // and the claim comes from the only party in a position to make it.
  //
  // The interval is recomputed from the change log, because a 304 is itself an
  // observation -- "we looked and it was still the same" -- and that is exactly
  // what the log is for. `neverSooner` is what makes it safe: evidence of *no*
  // change may only push the next read further out, never pull it closer, so a
  // feed resting at the ceiling is not dragged back by being checked.
  if (resolved.notModified) {
    const minutes =
      neverSooner(intervalFromChanges(feed.change_log, undefined, floor), feed.fetch_interval_minutes, floor) ??
      Number(feed.fetch_interval_minutes) ??
      MIN_INTERVAL;
    await q.markUnchanged(db, id, minutes, {
      etag: resolved.etag ?? null,
      lastModified: resolved.lastModified ?? null,
      changeLog: recordChange(feed.change_log, false),
    });
    return { ok: true, newItems: 0, notModified: true };
  }

  // Throttled, which is a different fact from failed and must not be recorded as
  // one. `markCrawlFailure` sets status='error', increments error_count and walks
  // the backoff ladder -- and at ten consecutive failures it marks the feed dead.
  // A publisher answering 429 is telling us we are asking too often; recording
  // that against *their* health would retire a working feed for our own
  // impatience, and it would do it to a whole platform at once, since one
  // backend's rate limit is hit by every feed hosted on it in the same minute.
  //
  // So: come back when asked, leave every health column exactly as it was.
  if (resolved.throttled) {
    await q.markThrottled(db, id, throttleMinutes(resolved.retryAfter));
    // `retryAfter` travels with the result so the caller can hold the rest of
    // this host's queue back by the same interval the server itself named.
    return {
      ok: false,
      newItems: 0,
      throttled: true,
      retryAfter: resolved.retryAfter ?? null,
      error: resolved.error,
    };
  }

  if (!resolved.ok) {
    const errorCount = Number(feed.error_count ?? 0) + 1;
    await q.markCrawlFailure(db, id, resolved.error, errorCount, backoffMinutes(errorCount));
    return { ok: false, newItems: 0, error: resolved.error };
  }

  // The ordinary path writes the whole crawl in one transaction. Production
  // catch-up mode instead uses serialized autocommits in `storeCrawl`, because
  // its remote explicit transactions are currently the slow path.
  //
  // This is the number that decides the crawler's throughput and nothing else
  // does. SQLite permits a single writer, so writes serialize -- a crawl costs
  // very nearly the count of transactions it opens, not the work inside them.
  // Measured on production: three transactions per feed gave a 300-feed tick of
  // 19.5 minutes, about 860 feeds an hour, against 2,400 before any of this.
  // Folding three into one is a threefold change; making any one of them
  // cheaper is not.
  //
  // The ordering below is what makes one transaction possible. Everything that
  // has to be *read* is read first, in parallel, and everything to be written
  // is assembled in memory before a single statement is sent.
  // Did the contents change since last time, judged by a fingerprint of what
  // the document identifies rather than of the bytes it arrived in? This is the
  // fallback for the majority of servers that send no validators at all, and it
  // answers the same question a 304 would, one parse later.
  //
  // A first crawl has nothing to compare against and counts as a change, which
  // is right: everything in the document is new to us. That is the *only* way to
  // be undecided here -- an empty document has a fingerprint like any other, so
  // a feed that consistently lists nothing reads as unchanged and decays,
  // instead of reading as changed and being fetched hourly for ever.
  const signature = contentSignature(resolved.feed.items);
  const knownSignature = feed.content_hash ? String(feed.content_hash) : null;
  const contentsChanged = knownSignature === null || signature !== knownSignature;
  const changeLog = recordChange(feed.change_log, contentsChanged);

  // How long to wait, in order of how good the evidence is.
  //
  // The document's own dates are best and cost nothing, since they were parsed
  // anyway. Failing those -- and about two percent of the directory states no
  // dates at all, while accounting for forty-four percent of the crawl demand --
  // the times we watched the contents change say the same thing about the same
  // publisher, measured on our clock instead of theirs. Only a feed with neither
  // falls to the old doubling ladder, which `storeCrawl` evaluates in SQL
  // because it needs a number this crawl cannot know until it has written.
  //
  // The asymmetry in the second branch is the important part. A crawl that saw
  // no change is evidence in one direction only, so it may lengthen the interval
  // and never shorten it; a crawl that saw one recomputes freely, which is what
  // lets an abandoned feed that starts publishing again accelerate on its first
  // new post.
  const dated = intervalFromDates(resolved.feed.items, undefined, floor);
  const observed = intervalFromChanges(changeLog, undefined, floor);
  const interval =
    dated ??
    (contentsChanged ? observed : neverSooner(observed, feed.fetch_interval_minutes, floor));

  // When this publisher last published, as distinct from when we last read
  // them. Stored on the feed row so a page can say "current, and dormant since
  // 2023" without a feed_items join -- see 0030. It falls out of the same date
  // scan the interval needed, so it is free.
  const published = newestPublished(resolved.feed.items);

  // Did this feed publish anything since we last looked?
  //
  // The old guard asked "did this crawl store new items", which is only knowable
  // *after* the write -- and needing that answer first is exactly what forced
  // topics and credits into transactions of their own. This asks the same
  // question of the document instead, from two values already in hand, so it can
  // be answered before anything is written.
  //
  // A feed with no usable dates cannot answer by date, and used to fall through
  // to the "have we ever done this" checks below -- which meant its topics and
  // credits were derived once, on its first crawl, and never revised however
  // much it went on to publish. The signature answers for it: no dates, but the
  // contents demonstrably changed, is the same fact arrived at differently.
  const knownPublished = feed.last_published_at ? String(feed.last_published_at) : null;
  const publishedSomethingNew =
    published !== null
      ? knownPublished === null || published > knownPublished
      : contentsChanged && knownSignature !== null;

  // Every read the crawl needs, at once, before any of it is written.
  //
  // `itemsForKeywords` is the interesting one. Topics are deliberately derived
  // from what is *stored* rather than from the document -- a feed carries only
  // its recent items, so extracting from the response alone would narrow a
  // blog's topics to whatever it published this month. Reading the stored items
  // *before* the upsert and adding the document's items in memory gives the
  // same set without the read-after-write that used to force a second
  // transaction.
  let storedItems = [];
  let hasAuthors = true;
  /** @type {Array<{ slug: string, keyword: string, words: number, count: number, source: string }>} */
  let storedTopics = [];
  if (AUXILIARY_WRITES) {
    // The topics come back in full rather than as a count, so the write below
    // can be a diff instead of a wholesale replace. Same round trip, same
    // index; see `keywordDiffStatements` for what it saves.
    [storedItems, storedTopics, hasAuthors] = await Promise.all([
      q.itemsForKeywords(db, id).catch(() => []),
      q.feedKeywordRows(db, id).catch(() => []),
      authors.feedHasAuthors(db, id).catch(() => true),
    ]);
  }

  // Topics, re-derived on every crawl.
  //
  // This used to be gated on `publishedSomethingNew || existingTopics === 0`,
  // which asked the wrong question. Topics come from `topicsFrom(feed, items)`
  // -- the *channel's* own categories, title and description as well as the
  // items -- so a publisher who retags their feed, renames it, or rewrites its
  // description has changed its topics without publishing anything at all. The
  // old guard could not see that, and a feed that went quiet was pinned to
  // whatever it was about on the last day it posted. `feeds.category` has
  // always been re-derived on every successful crawl for exactly this reason
  // (`upsertFeed` writes it unconditionally); topics now agree with it.
  //
  // This is affordable because of the diff below, not in spite of it. The three
  // reads it needs are already issued above whenever auxiliary writes are on,
  // so re-deriving adds no round trip -- `topicsFrom` is pure computation and
  // `keywordDiffStatements` returns an empty array when the extracted set
  // matches what is stored, which for a quiet feed is every time. The cost that
  // forced `CRAWL_AUXILIARY_WRITES=0` is *first* crawls, where every topic is a
  // genuine insert and no diff can help; that is a property of the backlog and
  // is unchanged by this.
  let topics = 0;
  /** @type {Array<{ sql: string, args: unknown[] }>} */
  let topicStatements = [];
  if (AUXILIARY_WRITES) {
    try {
      const extracted = topicsFrom(resolved.feed, storedItems);
      // A diff rather than a replace. Most re-crawls extract the topics the
      // feed already has, and rewriting six rows to the values they already
      // hold is the single largest avoidable write in the crawl.
      topicStatements = q.keywordDiffStatements(id, extracted, storedTopics);
      topics = extracted.length;
    } catch {
      // Topics are a browsing aid. Failing to extract them must not fail the
      // crawl -- that would back the feed off and eventually mark a perfectly
      // healthy blog dead.
      topicStatements = [];
      topics = 0;
    }
  }

  // Credits, on the same condition and for the same reason. "Stored for free"
  // was true of the parsing and false of the storing: this used to be three
  // write transactions per crawl, all of which rewrote the byline already on
  // file whenever the feed had not changed.
  let people = 0;
  /** @type {Array<{ sql: string, args: unknown[] }>} */
  let creditStatements = [];
  if (AUXILIARY_WRITES && (publishedSomethingNew || !hasAuthors)) {
    try {
      // The contacts are the feed's own, and they are passed here rather than
      // left to the enrichment pass because they cost nothing: the document is
      // already parsed, so a publisher who names no usable person but prints a
      // mailbox is reachable from the first crawl instead of from whenever the
      // week-long site walk gets to them.
      const prepared = await prepareCredits(
        db,
        { id, feed_url: String(feed.feed_url) },
        resolved.feed.credits ?? [],
        resolved.feed.contacts ?? [],
      );
      creditStatements = prepared.statements;
      people = prepared.people;
    } catch {
      // Same trade as topics: a byline that fails to store is a missing name,
      // where a byline that fails the crawl is a healthy blog on its way to
      // being marked dead.
      creditStatements = [];
      people = 0;
    }
  }

  const { stored: sent } = await q.storeCrawl(
    db,
    id,
    resolved.feed.items,
    resolved.feed,
    Number(feed.item_count ?? 0),
    interval,
    published,
    [...topicStatements, ...creditStatements],
    {
      etag: resolved.etag ?? null,
      lastModified: resolved.lastModified ?? null,
      contentHash: signature,
      changeLog,
    },
  );

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
 * @param {{ perHost?: number, crawl?: { resolve?: Function, scrape?: Function } }} [opts] `crawl` is
 *   handed to each `crawlFeed`, which is what makes a whole batch testable without
 *   the network — the throttle path in particular only exists across a host's queue.
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
  // Crawls the publisher answered with a 304, which cost a header exchange and
  // one small write instead of a document, a parse and an upsert. This is the
  // number that says whether conditional requests are actually being honoured
  // out there -- it is entirely up to other people's servers, so it cannot be
  // predicted and has to be measured.
  let unchanged = 0;
  // Hosts abandoned mid-queue because they answered 429. Distinct from `failed`:
  // nothing is wrong with these feeds and they were mostly never even asked.
  let throttled = 0;
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= queues.length) return;

      const queue = queues[index];

      for (let position = 0; position < queue.length; position += 1) {
        const feed = queue[position];
        const started = Date.now();

        // One feed that throws — a write that times out, a URL that breaks the
        // parser — must not reject the whole batch and take the other workers'
        // completed crawls down with it.
        try {
          const res = await crawlFeed(db, feed, opts.crawl);
          if (res.ok) {
            crawled += 1;
            items += Number(res.newItems ?? 0);
            if (res.notModified) unchanged += 1;
          } else failed += 1;

          report(onEvent, feed, started, {
            ok: res.ok,
            amount: res.ok ? Number(res.newItems ?? 0) : null,
            detail: res.ok ? null : (res.error ?? 'unknown'),
          });

          // A 429 is the host speaking for all of its feeds, so believe it once
          // and leave. The rest of this queue is the same server, and asking it
          // the same question another eight hundred times is precisely what it
          // just told us to stop doing — see `markHostThrottled` for the
          // measurement that put this here.
          if (res.throttled) {
            throttled += 1;
            const rest = queue.slice(position + 1);
            if (rest.length > 0) {
              await holdBackHost(db, rest, throttleMinutes(res.retryAfter), onEvent, feed);
            }
            break;
          }
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
  return { crawled, failed, items, unchanged, throttled, hosts: queues.length };
}

/**
 * Put back the feeds a throttled host never got asked about.
 *
 * Separated from the worker so the worker reads as the policy — believe the
 * 429, leave — rather than as the bookkeeping. Two things it must not do, and
 * both are why it exists as its own function:
 *
 *   * it must not fail the batch. These feeds are fine; the reschedule is an
 *     optimisation and the crawl has already done its useful work. If the write
 *     times out they keep their existing `next_fetch_at` and are simply offered
 *     again next tick, which is the behaviour this replaces.
 *   * it must not report the held-back feeds as errors. Nothing was wrong with
 *     them and nothing was even sent, so a per-feed line would put hundreds of
 *     healthy feeds on the failure panel. One line for the host says it.
 *
 * @param {import('@libsql/client').Client} db
 * @param {Array<{ id: string }>} rest feeds left unread on this host
 * @param {number} minutes how long before the first is tried again
 * @param {((event: object) => void)|null} onEvent
 * @param {{ feed_url: string, title?: unknown }} feed the one that was refused
 * @returns {Promise<void>}
 */
async function holdBackHost(db, rest, minutes, onEvent, feed) {
  const started = Date.now();

  try {
    // Spread across an hour rather than returned all at once: a thousand feeds
    // handed back to the same instant is the same pile-up one tick later.
    await q.markHostThrottled(
      db,
      rest.map((f) => f.id),
      minutes,
      60,
    );
  } catch {
    // The schedule is unchanged, so they come back next tick exactly as they
    // would have without this. Losing the batch over it would be worse.
    return;
  }

  if (typeof onEvent !== 'function') return;

  try {
    onEvent({
      at: new Date().toISOString(),
      event: 'host-throttled',
      status: 'info',
      subject: hostOf(feed),
      slug: null,
      amount: rest.length,
      // Not `message`: `toEntry` reads any row carrying one as an error, and
      // this is the crawler behaving correctly. See the daemon error panel note.
      detail: `held back ${rest.length} feeds for ${minutes}m`,
      ms: Date.now() - started,
    });
  } catch {
    // A broken listener loses its line and nothing else.
  }
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
