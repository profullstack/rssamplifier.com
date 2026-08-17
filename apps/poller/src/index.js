import { connect, migrate, q, accounts, alerts } from '@rssamplifier/db';
import {
  crawlDue,
  enrichDue,
  notifyFinishedSubmissions,
  notifyFinishedDiscoveries,
  drainDiscoveryQueue,
  drainDiscoveryKeywords,
  drainImport,
} from '@rssamplifier/ingest';
import { runDueSources, discoverFromOwnTopics } from '@rssamplifier/discover';
import { findFeedCard } from '@rssamplifier/feed';
import { deliverAlerts, vapidConfig } from '@rssamplifier/notify';

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
// How many feeds from one host may enter a single batch. A host's feeds are
// crawled strictly in series, so without a cap the largest host in the batch
// sets the batch's wall-clock: half this directory lives on two domains, and an
// unspread batch handed one worker a hundred feeds while the rest finished in
// seconds. Raise it only alongside evidence that a host can absorb it.
const perHost = Number(env['POLL_PER_HOST']) || 8;
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

// Feeds looked at for authorship per pass, and how often a pass runs.
//
// Deliberately the smallest batch in this file. Each feed costs three to five
// fetches of somebody's blog, and unlike a crawl those pages are not a machine
// interface — they are the site itself. Five a minute walks the whole
// directory in about a week, which is far faster than people change where they
// can be found, and slow enough that no publisher notices us doing it.
const authorBatch = Number(env['AUTHOR_BATCH_SIZE']) || 5;
const authorIntervalMs = (Number(env['AUTHOR_INTERVAL_SECONDS']) || 60) * 1000;
// How long before a feed is looked at again. Long, because the answer changes
// when somebody redesigns their blog or joins a new network, not weekly.
const authorRecheckDays = Number(env['AUTHOR_RECHECK_DAYS']) || 90;
// Whether to spend requests proving a rel="me" link points back. Off by
// default: it triples the cost of an author who has three profiles, and the
// unverified link is still the right link almost every time.
const authorVerify = env['AUTHOR_VERIFY'] === '1' || env['AUTHOR_VERIFY'] === 'true';
// Enrichment can be turned off outright without redeploying the crawler, which
// is the switch to reach for if a site ever objects to the extra fetches.
const authorEnabled = env['AUTHOR_ENRICH'] !== '0' && env['AUTHOR_ENRICH'] !== 'false';

// Accounts considered per alert pass, and how often a pass runs. Its own timer
// for the same reason the card and cluster passes have one: a tick spends
// minutes inside the crawl, and work queued behind that only happens if the
// process lives long enough to reach it — which, on a day of deploys, it does
// not. Two minutes rather than one because an alert is not a race: the point is
// to be told within a few minutes, and halving the delay would double the
// number of digests a busy topic produces.
const alertUsers = Number(env['ALERT_BATCH_SIZE']) || 25;
const alertIntervalMs = (Number(env['ALERT_INTERVAL_SECONDS']) || 120) * 1000;

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
// Guards the enrichment pass against overlapping itself. A batch of five feeds
// that each need four fetches of a slow server can outlast its own interval.
let enriching = false;

// And for the alert pass, where stacking would be worse than wasteful: two
// overlapping passes read the same watermark and would send the same digest
// twice.
let alerting = false;
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
    const { crawled, failed, items, hosts } = await crawlDue(
      db,
      batchSize,
      concurrency,
      publishLog ? recorder.record : null,
      { perHost },
    );
    if (crawled || failed) {
      // The backlog is the number worth watching: crawled/failed only say the
      // tick did something, `due` says whether the crawler is keeping up.
      log('crawl', {
        crawled,
        failed,
        items,
        // How many distinct hosts the batch touched. The number that says
        // whether the worker pool had anything to do: `crawled` and `ms`
        // together look identical for a batch spread over 80 hosts and one
        // stuck behind 4, and only one of those is a problem worth fixing.
        hosts,
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
    // `amount` is set alongside each event's own fields rather than instead of
    // them: the log's amount column is what /crawlstats reads to decide whether a
    // job is moving, and a summary line that leaves it null reports a busy worker
    // as a stalled one. The named field stays in the payload, so the wording in
    // the live log is unchanged.
    const searched = await drainDiscoveryKeywords(db, keywordBatch);
    if (searched.searched || searched.failed || searched.fatal) {
      log('discovery-search', { ...searched, amount: searched.searched });
    }

    const discovered = await drainDiscoveryQueue(db, discoveryBatch);
    if (discovered.checked) log('discovery', { ...discovered, amount: discovered.checked });

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

    // An upload hands over its list and leaves; this is where the list becomes
    // feeds. One slice a tick rather than a whole submission, so a very large
    // catalogue cannot hold the crawl above hostage while it queues — the two
    // share the process and the import is the one that can wait.
    try {
      const drained = await drainImport(db);
      if (drained.ran) {
        log('import-drain', {
          submission: drained.submissionId,
          queued: drained.queued,
          skipped: drained.skipped,
          remaining: drained.remaining,
          finished: drained.finished,
        });
      }
    } catch (err) {
      // One bad slice must not take the crawl down with it; the entries are
      // still staged, so the next tick tries again.
      log('import-drain-error', { message: String(err?.message ?? err) });
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

      // What has already been alerted about. A working set, not a history —
      // nothing consults a row past the re-alert window.
      const told = await alerts.pruneAlertSent(db);
      if (told) log('purged-alerts', { rows: told });
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
      log('cluster-backfill', {
        scanned: filled.scanned,
        keyed: filled.keyed,
        amount: filled.keyed,
      });
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
    log('cards', {
      looked: feeds.length,
      found,
      cards,
      pending: coverage.pending,
      amount: feeds.length,
    });
  } catch (err) {
    log('card-tick-error', { message: String(err?.message ?? err) });
  } finally {
    carding = false;
  }
}

/**
 * Tell people about the posts they asked to be told about.
 *
 * The crawl above is what makes this possible and also what makes it need its
 * own timer: a pass runs against the rows the crawl has just written, and
 * anything scheduled *after* a crawl on this process only happens when the crawl
 * finishes early enough — which on a busy tick it does not.
 *
 * Never allowed to overlap itself. Two passes reading the same watermark would
 * each decide the same posts were new, and the second one's digest would be a
 * duplicate that nothing downstream could take back.
 */
async function alertTick() {
  if (stopping || alerting) return;
  alerting = true;

  try {
    const result = await deliverAlerts(db, { users: alertUsers });

    // Logged whenever there was anybody to consider, and not only when
    // something was sent — which is the opposite of the rule the card pass
    // above follows, for a reason worth stating.
    //
    // The steady state of this pass is finding nothing: most hours, nobody any
    // account follows publishes anything. A job that writes a line only on the
    // interesting minutes is indistinguishable on /crawlstats from a job that
    // has died, and "has the sender stopped?" is exactly the question this
    // feature makes worth asking. One line every couple of minutes — and only
    // on a deployment where somebody has switched alerts on at all — is a fair
    // price for that being answerable.
    //
    // `amount` is the field /crawlstats reads as a job's throughput, so what
    // goes in it is what this job should be measured by: posts alerted about,
    // not accounts looked at, which is flat whatever happens.
    if (result.users) log('alerts', { ...result, amount: result.items });
  } catch (err) {
    log('alert-error', { message: String(err?.message ?? err) });
  } finally {
    alerting = false;
  }
}

/**
 * Find out who writes the feeds, one small batch at a time.
 *
 * On its own timer for the reason the cluster backfill is: anything placed
 * after the crawl inside `tick()` only runs when the process survives the
 * crawl, and a pass that needs a week of steady progress cannot depend on
 * that. It is also the slowest work in the daemon per unit — several fetches
 * of one publisher's site — so keeping it off the crawl's clock means a slow
 * blog delays nothing but the next author.
 */
async function enrichTick() {
  if (!authorEnabled || stopping) return;
  if (enriching) return;
  enriching = true;

  try {
    const result = await enrichDue(db, authorBatch, {
      verify: authorVerify,
      recheckDays: authorRecheckDays,
      onEvent: publishLog ? recorder.record : null,
    });
    // Silent when nothing was due, which is the steady state once the
    // directory has been walked and before anything is old enough to recheck.
    if (result.feeds) log('authors', result);
  } catch (err) {
    log('authors-error', { message: String(err?.message ?? err) });
  } finally {
    enriching = false;
  }
}

const timer = setInterval(tick, intervalMs);
const backfillTimer = setInterval(backfillTick, clusterIntervalMs);
const cardTimer = setInterval(cardTick, cardIntervalMs);
const alertTimer = setInterval(alertTick, alertIntervalMs);
const enrichTimer = setInterval(enrichTick, authorIntervalMs);
void tick();
void backfillTick();
void cardTick();
void alertTick();
void enrichTick();

log('started', {
  intervalSeconds: intervalMs / 1000,
  batchSize,
  concurrency,
  discoveryBatch,
  authorBatch: authorEnabled ? authorBatch : 0,
  // Said out loud on boot, because a deployment missing the VAPID pair looks
  // exactly like one where nobody has switched browser alerts on — and the two
  // are a config change apart.
  push: Boolean(vapidConfig()),
});

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
  clearInterval(enrichTimer);
  clearInterval(alertTimer);

  // Recorded before the buffer is closed, so the live log's last line is the
  // daemon saying it stopped rather than the log simply going quiet — which is
  // what a crash looks like.
  log('stopping', { signal });

  const deadline = Date.now() + 20_000;
  const wait = setInterval(() => {
    if ((!running && !enriching) || Date.now() > deadline) {
      clearInterval(wait);
      // Whatever the last batch logged is still in memory: two seconds of lines
      // is exactly what a 20-second drain would otherwise throw away.
      void recorder.stop().finally(() => process.exit(0));
    }
  }, 250);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
