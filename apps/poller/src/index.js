import { connect, migrate, q, accounts } from '@rssamplifier/db';
import {
  crawlDue,
  notifyFinishedSubmissions,
  notifyFinishedDiscoveries,
  drainDiscoveryQueue,
  drainDiscoveryKeywords,
} from '@rssamplifier/ingest';
import { runDueSources, discoverFromOwnTopics } from '@rssamplifier/discover';
import { findFeedCard } from '@rssamplifier/feed';

import { createRecorder, toEntry } from './log.js';

/**
 * Feed crawler daemon.
 *
 * Runs as its own Railway service so a slow crawl can never occupy a web
 * request, and so the two scale apart.
 */

const env = process.env;

if (!env['TURSO_DATABASE_URL']) {
  console.error('TURSO_DATABASE_URL must be set');
  process.exit(1);
}

const db = connect();

const intervalMs = (Number(env['POLL_INTERVAL_SECONDS']) || 60) * 1000;
const batchSize = Number(env['POLL_BATCH_SIZE']) || 25;
// Hosts fetched at once. The batch spans thousands of distinct domains, so this
// is throughput, not pressure on any one server — crawlDue keeps a single host's
// feeds strictly sequential regardless of this number.
const concurrency = Number(env['POLL_CONCURRENCY']) || 8;
// Discovery candidates checked per tick. Smaller than the crawl batch on
// purpose: each one is a cold site that may need three fetches to find a feed,
// and unlike a crawl it is speculative work nobody is waiting on.
const discoveryBatch = Number(env['DISCOVERY_BATCH_SIZE']) || 10;
// Keyword searches per tick. Each one spends a credit against a metered monthly
// plan, so this is a budget as much as a batch size: at the default tick of 60
// seconds, five per tick is 7,200 searches a day if the queue is ever that deep.
const keywordBatch = Number(env['DISCOVERY_KEYWORD_BATCH_SIZE']) || 5;

// How often the topics rollup is rebuilt. It is one grouped scan of
// feed_keywords, and the index it feeds is a browsing aid — a topic's own page
// reads the keywords directly and is never stale, so the only thing a longer
// gap costs is how quickly a new topic shows up in the list.
const topicsIntervalMs = (Number(env['TOPICS_REFRESH_SECONDS']) || 900) * 1000;

// How often the daemon looks at its discovery sources. The sources have their
// own per-source schedules — a hand-maintained list is re-read daily, not
// hourly — so this only decides how often that schedule is consulted.
const sourceIntervalMs = (Number(env['DISCOVERY_SOURCE_INTERVAL_SECONDS']) || 1800) * 1000;
// How often the directory goes looking for more of what it already covers.
// Daily, because each pass spends search credits against a shared account and
// the supply of topics worth searching grows at the speed of the crawler.
const topicSearchIntervalMs = (Number(env['DISCOVERY_TOPIC_INTERVAL_SECONDS']) || 86400) * 1000;

// Feeds whose picture is looked up per pass. Small, because each one is a page
// fetch plus up to two image probes against a cold host — and unlike a crawl,
// nobody is waiting on it.
const cardBatch = Number(env['CARD_BACKFILL_BATCH']) || 8;
// How often that pass runs. Its own timer for the same reason the cluster walk
// below has one: a tick spends minutes inside the crawl, and work queued after
// that only happens if the process lives long enough to reach it.
const cardIntervalMs = (Number(env['CARD_BACKFILL_SECONDS']) || 20) * 1000;

// Items keyed for grouping per tick. Each one is a title hashed in process and
// a single-column update, so the batch is bounded by the write round trip
// rather than by CPU.
const clusterBatch = Number(env['CLUSTER_BACKFILL_BATCH']) || 500;
// How often the backfill takes another page. Its own cadence rather than the
// crawl's: at 500 rows every 10 seconds a 1.4M-row table is walked in about
// eight hours, and the walk is a bounded indexed read either way.
const clusterIntervalMs = (Number(env['CLUSTER_BACKFILL_SECONDS']) || 10) * 1000;

// Whether the daemon's log is also written to the database, where /crawlstats
// can stream it. On by default; an operator debugging against a production
// database from a laptop can turn it off so their own runs stay out of the
// public log.
const publishLog = env['CRAWL_LOG'] !== '0' && env['CRAWL_LOG'] !== 'false';

const recorder = createRecorder({
  append: (entries) => q.appendCrawlLog(db, entries),
  // A failed log write is reported to stdout only. Recording it would either
  // recurse or queue a line into the buffer that just failed to drain.
  onError: (err) => console.error('crawl log write failed:', String(err?.message ?? err)),
});

let running = false;
let stopping = false;
// Whether any item still lacks a grouping key. Latches off for good once the
// walk reaches the end of the table, so a finished backfill costs nothing on
// every later tick.
let clusterBackfill = true;
// How far through feed_items the walk has got. Held in memory rather than
// stored: a restart re-walks from the start, and re-walking is cheap because
// rows that already carry a key are read and skipped without a write.
let clusterCursor = '';
// Guards the walk against overlapping itself if one page runs long.
let backfilling = false;
// The same guard for the card pass, which makes outbound requests and so must
// never be allowed to stack.
let carding = false;
let lastPurge = 0;
let lastSources = 0;
let lastTopicSearch = 0;
let lastTopics = 0;

/**
 * Structured one-line log, so Railway's viewer stays greppable.
 *
 * The same line is buffered for the database, which is how /crawlstats can show
 * a log of a process it does not share a machine with. stdout is written first
 * and unconditionally: it is the durable copy, and it must survive whatever the
 * database is doing.
 *
 * @param {string} event
 * @param {object} [fields]
 */
function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
  if (publishLog) recorder.record(toEntry(event, fields));
}

/**
 * Crawl one batch, guarding against overlapping runs.
 *
 * A slow batch must not stack on top of the next tick — that would multiply
 * outbound requests to the same hosts.
 */
async function tick() {
  if (running || stopping) return;
  running = true;

  try {
    const started = Date.now();

    // Per-feed lines are recorded for the live log and deliberately kept off
    // stdout: they are the content of a log somebody is watching, and twenty-five
    // a minute forever is not what Railway's viewer is for. The tick summary
    // below is the durable record of the same work.
    const { crawled, failed, items } = await crawlDue(
      db,
      batchSize,
      concurrency,
      publishLog ? recorder.record : null,
    );
    if (crawled || failed) {
      // The backlog is the number worth watching: crawled/failed only say the
      // tick did something, `due` says whether the crawler is keeping up.
      log('crawl', {
        crawled,
        failed,
        items,
        ms: Date.now() - started,
        due: await q.countDueFeeds(db),
      });
    }

    // What this tick did, added to the hour it happened in. Only when it did
    // something: an idle tick writing a row of zeros would turn the throughput
    // chart's "nothing was due" into a recorded hour of no work, and the two
    // are worth telling apart. A failure here is housekeeping lost, not a
    // crawl lost, so it must not break the tick.
    if (crawled || failed) {
      try {
        await q.recordCrawlHour(db, { fetched: crawled + failed, succeeded: crawled, failed, items });
      } catch (err) {
        log('rollup-error', { message: String(err?.message ?? err) });
      }
    }

    // A keyword search queues more work than its request could finish, in both
    // phases: keywords still to search, then the sites those searches turn up.
    // Both run after the crawl — an indexed blog going stale matters more than
    // finding a new one.
    const searched = await drainDiscoveryKeywords(db, keywordBatch);
    if (searched.searched || searched.failed || searched.fatal) log('discovery-search', searched);

    const discovered = await drainDiscoveryQueue(db, discoveryBatch);
    if (discovered.checked) log('discovery', discovered);

    // Sources fill the queue the drain above empties. Checked on a long timer
    // and rate-limited to one source per pass: each is a request to somebody
    // else's server for a list that changes when a human edits it.
    if (Date.now() - lastSources > sourceIntervalMs) {
      lastSources = Date.now();
      try {
        for (const result of await runDueSources(db)) {
          log('discovery-source', result);
        }
      } catch (err) {
        // A source being unreachable must not stop the crawl loop.
        log('discovery-source-error', { message: String(err?.message ?? err) });
      }
    }

    // The directory searching for more of what it already covers. A no-op
    // without a search key, and a no-op once every shared topic has been
    // searched once — both are ordinary states, so neither is logged.
    if (Date.now() - lastTopicSearch > topicSearchIntervalMs) {
      lastTopicSearch = Date.now();
      try {
        const topics = await discoverFromOwnTopics(db);
        if (topics.ran) log('discovery-topics', { keywords: topics.keywords, runId: topics.runId });
      } catch (err) {
        log('discovery-topics-error', { message: String(err?.message ?? err) });
      }
    }

    // Queued submissions finish long after the upload, so the daemon that
    // drains the queue is also what tells the submitter it drained. A no-op
    // when no mail provider is configured.
    const notified = await notifyFinishedSubmissions(db);
    if (notified.sent || notified.failed) log('notified', notified);

    const toldSearchers = await notifyFinishedDiscoveries(db);
    if (toldSearchers.sent || toldSearchers.failed) log('notified-discovery', toldSearchers);

    // Expired sessions and spent challenges are already refused on read, so
    // clearing them is housekeeping — and this is the process that runs anyway.
    // Hourly rather than every tick: it is three deletes over indexed columns
    // and there is nothing to gain from doing them sixty times an hour.
    // The topics index is a projection of the keywords the crawl above just
    // rewrote, so it is rebuilt by the process that invalidated it.
    if (Date.now() - lastTopics > topicsIntervalMs) {
      lastTopics = Date.now();
      const topics = await q.refreshTopics(db);
      log('topics', { topics, ms: Date.now() - lastTopics });
    }

    if (Date.now() - lastPurge > 3_600_000) {
      lastPurge = Date.now();
      const purged = await accounts.purgeExpired(db);
      if (purged) log('purged', { rows: purged });

      // The throughput rollup grows by 24 rows a day forever otherwise, and no
      // chart on the site looks back further than a month.
      const hours = await q.pruneCrawlHours(db);
      if (hours) log('purged-rollup', { rows: hours });

      // The live log takes a row per feed crawled, so it is the one table here
      // that would grow by six figures a week if nobody swept it.
      const lines = await q.pruneCrawlLog(db);
      if (lines) log('purged-log', { rows: lines });
    }
  } catch (err) {
    log('crawl-error', { message: String(err?.message ?? err) });
  } finally {
    running = false;
  }
}

// The daemon owns schema migration: it is the one service guaranteed to be
// running, and applying on boot means there is no separate deploy step.
try {
  const { applied } = await migrate(db);
  if (applied.length) log('migrated', { applied });
} catch (err) {
  console.error('migration failed:', err);
  process.exit(1);
}

/**
 * Key the items stored before the grouping column existed.
 *
 * On its own timer, and not a step of `tick()`, which is where it started and
 * where it did not work. A tick spends minutes inside the crawl, and anything
 * after that only runs if the process survives long enough to reach it — on a
 * day of frequent deploys it never did, and the walk logged nothing at all
 * while looking exactly like a backfill that had finished. Given its own timer
 * it makes progress regardless of how long a crawl takes or when the next
 * restart lands.
 *
 * It is small, indexed work against a database the crawl is already talking to,
 * so running it alongside a crawl rather than after one costs nothing worth
 * measuring.
 */
async function backfillTick() {
  if (!clusterBackfill || stopping) return;
  if (backfilling) return; // never let two walks overlap the same cursor
  backfilling = true;

  try {
    const filled = await q.backfillClusterKeys(db, clusterBatch, clusterCursor);
    if (filled.cursor === null) {
      // Walked off the end of the table. Done for the life of this process;
      // everything stored from here on is keyed as it arrives.
      clusterBackfill = false;
      clearInterval(backfillTimer);
      log('cluster-backfill-done', {});
    } else {
      clusterCursor = filled.cursor;
      // Logged on every pass that read anything, not only ones that wrote.
      // A silent worker and an absent one are indistinguishable, which is the
      // mistake that hid this the first time.
      log('cluster-backfill', { scanned: filled.scanned, keyed: filled.keyed });
    }
  } catch (err) {
    log('cluster-backfill-error', { message: String(err?.message ?? err) });
  } finally {
    backfilling = false;
  }
}

/**
 * Go and look at what each feed offers as its picture.
 *
 * The directory stores whatever cover art a feed declared, and three quarters of
 * the blogs in it declared none — so a listing had nothing to put beside their
 * names, and a shared link had no card. Both are answered by the same look: the
 * site's own og:image, fetched, with the first few kilobytes read to find out how
 * big the image really is. The size is what makes it safe to promise to a
 * crawler, and a URL cannot be trusted for it — a favicon and a 1200x630 card
 * are the same string as far as the markup is concerned.
 *
 * Its own timer, and a small batch, because this is speculative work against
 * other people's servers. Every feed is answered exactly once: a publisher with
 * no picture is recorded as such rather than being asked again tomorrow.
 */
async function cardTick() {
  if (stopping || carding) return;
  carding = true;

  try {
    const feeds = await q.feedsNeedingCard(db, cardBatch);
    if (feeds.length === 0) {
      // Nothing waiting. Not logged: this is the steady state once the backfill
      // has drained, and a line a second saying so is not a log.
      return;
    }

    let found = 0;
    let cards = 0;

    // Sequentially rather than in parallel. The batch is small, each feed is one
    // page and up to two images from a stranger's server, and the crawl running
    // alongside this already owns the outbound request budget.
    for (const feed of feeds) {
      if (stopping) break;

      try {
        const card = await findFeedCard({
          imageUrl: feed.image_url ? String(feed.image_url) : '',
          siteUrl: feed.site_url ? String(feed.site_url) : '',
        });

        await q.setFeedCard(db, String(feed.id), card);
        if (card.state === 'ok') found += 1;
        if (card.fit === 'large' || card.fit === 'small') cards += 1;
      } catch (err) {
        // One publisher's server misbehaving must not stop the batch, and the
        // row is marked so the queue moves on rather than handing it back.
        await q
          .setFeedCard(db, String(feed.id), { state: 'error' })
          .catch(() => {});
        log('card-error', { slug: String(feed.slug ?? ''), message: String(err?.message ?? err) });
      }
    }

    const coverage = await q.cardCoverage(db);
    log('cards', { looked: feeds.length, found, cards, pending: coverage.pending });
  } catch (err) {
    log('card-tick-error', { message: String(err?.message ?? err) });
  } finally {
    carding = false;
  }
}

const timer = setInterval(tick, intervalMs);
const backfillTimer = setInterval(backfillTick, clusterIntervalMs);
const cardTimer = setInterval(cardTick, cardIntervalMs);
void tick();
void backfillTick();
void cardTick();

log('started', { intervalSeconds: intervalMs / 1000, batchSize, concurrency, discoveryBatch });

/**
 * Shut down cleanly so Railway's SIGTERM does not sever an in-flight crawl.
 *
 * @param {string} signal
 */
function shutdown(signal) {
  stopping = true;
  clearInterval(timer);
  clearInterval(backfillTimer);
  clearInterval(cardTimer);

  // Recorded before the buffer is closed, so the live log's last line is the
  // daemon saying it stopped rather than the log simply going quiet — which is
  // what a crash looks like.
  log('stopping', { signal });

  const deadline = Date.now() + 20_000;
  const wait = setInterval(() => {
    if (!running || Date.now() > deadline) {
      clearInterval(wait);
      // Whatever the last batch logged is still in memory: two seconds of lines
      // is exactly what a 20-second drain would otherwise throw away.
      void recorder.stop().finally(() => process.exit(0));
    }
  }, 250);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
