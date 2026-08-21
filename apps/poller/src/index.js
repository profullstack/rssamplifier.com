import {
  connect,
  createWriteWorker,
  migrate,
  q,
  accounts,
  alerts,
  takeWriteTally,
  warmStatsCache,
} from '@rssamplifier/db';
import {
  crawlDue,
  enrichDue,
  searchDue,
  notifyFinishedSubmissions,
  notifyFinishedDiscoveries,
  drainDiscoveryQueue,
  drainDiscoveryKeywords,
  drainImport,
} from '@rssamplifier/ingest';
import { runDueSources, discoverFromOwnTopics } from '@rssamplifier/discover';
import { findFeedCard } from '@rssamplifier/feed';
import { deliverAlerts, vapidConfig } from '@rssamplifier/notify';

import { createRecorder, toEntry, writeFailure } from './log.js';

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
// A large imported first-crawl queue should own the daemon until it is under
// control. Discovery, imports and housekeeping are resumable; running them
// after every crawl can leave the next batch waiting minutes for a constrained
// database writer.
const catchupOnly = ['1', 'true'].includes(String(env['CRAWL_CATCHUP'] ?? '').toLowerCase());
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
const cardEnabled = env['CARD_BACKFILL'] !== '0' && env['CARD_BACKFILL'] !== 'false';
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

// Feeds looked at for authorship per pass, how many publishers are asked at
// once, and how often a pass runs.
//
// Still the gentlest work in this file per publisher: each feed costs three to
// five fetches of somebody's blog, and unlike a crawl those pages are not a
// machine interface — they are the site itself. What changed is the arithmetic
// around that. "Five a minute walks the directory in about a week" was true of
// the 52,691 feeds there were when this was written; there are now 369,054, so
// the same setting needs about ten months. And it never actually ran at five a
// minute: the pass was serial, a slow site can hold a 15-second timeout three
// times over, and `enrichTick` skips a tick while the last one is still going
// — so a batch of five regularly outlasted its own interval. Measured over the
// first two days in production: 1,536 feeds, an eighth of the configured rate.
//
// None of which is why the directory has no authors today. `AUTHOR_ENRICH=0`
// and `CRAWL_AUXILIARY_WRITES=0` are both set in production, and switching them
// off took the crawl from ~300 feeds an hour to ~5,000. That is the real
// constraint and it is a write constraint; the settings below only start
// mattering once those are switched back on.
//
// Raised, but nowhere near as far as the fetch budget alone would allow, and
// the reason is writes rather than politeness. Each enriched feed opens a write
// transaction, an empty one against this database currently costs ~2.5s, and
// they serialize — so enrichment competes directly with the crawl for the one
// resource the crawl is already short of. Forty a minute would spend more write
// time than the crawler has to give. Ten across four publishers is roughly
// eight times the wall-clock throughput of the serial pass at a write rate the
// crawl can absorb, and walks the directory in about five weeks.
//
// Both numbers are env-tunable because the right value moves with the write
// budget: when the backlog is clear and an empty transaction is fast again,
// this can go up a long way before the fetching becomes the limit.
//
// No publisher is asked for more than one page at a time at any setting — that
// guarantee lives in `enrichDue` and was never what cost the throughput.
const authorBatch = Number(env['AUTHOR_BATCH_SIZE']) || 10;
const authorConcurrency = Number(env['AUTHOR_CONCURRENCY']) || 4;
const authorIntervalMs = (Number(env['AUTHOR_INTERVAL_SECONDS']) || 60) * 1000;
// How often each queue's depth is written down for the burndown chart. Ten
// minutes is six samples an hour where only the last is kept, which sounds
// wasteful and is not: it means the current hour's point is never more than ten
// minutes stale on a page that refreshes every fifteen seconds.
const queueSampleMs = (Number(env['QUEUE_SAMPLE_SECONDS']) || 600) * 1000;

// How often the category breakdown is recomputed into Redis for /crawlstats.
//
// It is a ~59-second read of every feed, which is why it cannot live on a
// request: with a 30-second deadline in front of it, it could only ever fail,
// so the cache it was supposed to fill stayed empty and every visitor paid the
// full timeout. Five minutes is far more often than the number moves -- it is
// the shape of a directory of half a million feeds -- and the point is only
// that Redis is never empty, not that it is current to the second.
const statsWarmMs = (Number(env['STATS_WARM_SECONDS']) || 300) * 1000;

// Where the write queue lives. Absent, `connect()` falls back to the
// in-process serialiser and this daemon starts no worker — the system as it
// shipped before the queue existed, which is the right thing to degrade to.
const redisUrl = env['REDIS_URL'] ?? '';

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

// A GitHub credential, and the difference between the profile lookups working
// and not working at all: unauthenticated, the API allows **60 requests an hour
// per IP**, which a single batch spends. With a token it is 5,000, which is
// more than this pass can use. Optional only in the sense that the rest of the
// enrichment carries on without it -- profile resolution simply stops finding
// anything once the hour's 60 are gone, and does so quietly, as a 403.
const authorGithubToken = String(env['GITHUB_TOKEN'] ?? '').trim();

// Buying searches for the people who left no trail.
//
// **Off unless every one of these is set**, and that is the design rather than
// caution. The credits are metered, they come from an account shared with
// another product, and there are 369,056 feeds here -- one query each would be
// fifteen times the monthly allowance. So it takes a key, a non-zero budget,
// and an explicit switch, and the budget is counted from the ledger in the
// database rather than from a variable, because this process restarts on every
// deploy and a budget that resets with it is not a budget.
const searchEnabled = env['AUTHOR_SEARCH'] === '1' || env['AUTHOR_SEARCH'] === 'true';
const searchApiKey = String(env['VALUESERP_API_KEY'] ?? '').trim();
const searchMonthlyBudget = Number(env['AUTHOR_SEARCH_BUDGET']) || 0;
const searchPerAuthor = Number(env['AUTHOR_SEARCH_PER_AUTHOR']) || 2;
const searchBatch = Number(env['AUTHOR_SEARCH_BATCH']) || 5;
// Slow on purpose: this is the one pass that costs money per unit of work, so
// its default cadence spends at most a few credits an hour even misconfigured.
const searchIntervalMs = (Number(env['AUTHOR_SEARCH_INTERVAL_SECONDS']) || 900) * 1000;

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
let clusterBackfill = env['CLUSTER_BACKFILL'] !== '0' && env['CLUSTER_BACKFILL'] !== 'false';
// There is no cursor any more. There used to be, and holding it in memory was
// the whole problem: the walk restarted at the beginning of a 1.75M-row table
// on every deploy, so it re-read the same already-keyed rows for a day and
// never reached the 15,821 that needed work. The query now asks for unkeyed
// rows directly and is therefore stateless — a restart resumes exactly where
// the work is. See `backfillClusterKeys`.
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

// And for the queue sample, where an overlap would be pure waste: both passes
// would read the same counts and write the same row.
let sampling = false;
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
    const { crawled, failed, items, unchanged, hosts } = await crawlDue(
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
        // Of those crawls, how many the publisher answered with a 304 -- a
        // header exchange and one small write, instead of a document, a parse
        // and an upsert. Whether a server honours a conditional request is
        // entirely up to that server, so this cannot be predicted from here and
        // has to be watched.
        unchanged,
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

    // An upload hands over its list and leaves; this is where the list becomes
    // feeds. One slice a tick rather than a whole submission, so a very large
    // catalogue cannot hold the crawl above hostage while it queues — the two
    // share the process and the import is the one that can wait.
    //
    // Above the catch-up return, and deliberately the only thing that is.
    // Everything below is work nobody asked for by name: discovery finds feeds
    // on its own schedule, cards and clusters decorate what is already indexed,
    // and none of it has somebody watching a page. An import is the opposite —
    // a person handed us a list, was given a URL to follow, and that page says
    // "working". In catch-up mode it said "working" for ever: a 109,474-entry
    // upload on 2026-08-19 staged all its entries in 55 seconds and then sat at
    // 0 queued, because this block was eleven lines below a `return`. Nothing
    // errored, nothing logged, and the only way to find out was to read the
    // poller source.
    //
    // Catch-up mode exists to stop unrelated writes competing with a deep
    // first-crawl backlog, and that reasoning holds for everything else here.
    // It does not hold for the one queue a user is actively waiting on, and a
    // slice a tick is a small enough price that it never had to.
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

    // Above the return for the same reason, and because the two are a pair: the
    // daemon that drains the queue is the one that tells the submitter it
    // drained. Draining in catch-up mode while leaving this below would finish
    // somebody's upload and never say so, which is a stranger failure than not
    // draining at all. A no-op when no mail provider is configured.
    //
    // Guarded, unlike where it used to sit. Down there a throw only cost the
    // housekeeping that followed it; up here it would cost the crawl.
    try {
      const notified = await notifyFinishedSubmissions(db);
      if (notified.sent || notified.failed) log('notified', notified);
    } catch (err) {
      log('notify-error', { message: String(err?.message ?? err) });
    }

    // Retention sweeps run on both sides of the return, deliberately. Catch-up
    // mode defers work that can be caught up; a retention window cannot be —
    // skipping it does not postpone the deletes, it keeps the rows. See
    // `purgeTick`, which found crawl_log holding 64 hours of a 12-hour window.
    await purgeTick();

    // All work below is resumable enrichment or housekeeping. In recovery mode
    // the deep first-crawl queue is the job, and returning here lets the next
    // minute tick begin immediately instead of waiting behind unrelated writes.
    if (catchupOnly) return;

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

  } catch (err) {
    log('crawl-error', { message: String(err?.message ?? err) });
  } finally {
    running = false;
  }
}

/**
 * Sweep the tables that grow by themselves.
 *
 * Hoisted out of the bottom of `tick()`, where it sat below
 * `if (catchupOnly) return`. `CRAWL_CATCHUP=1` is set in production, so it had
 * not run in as long as catch-up has been on, and the consequence is not a
 * tidier backlog for later — these are retention windows, and a retention
 * window that stops running is not deferred, it is abandoned. `crawl_log` is
 * written to prune at twelve hours and production was holding **sixty-four**,
 * which is 5x the rows the design intends, on the table that takes a row per
 * feed crawled.
 *
 * That is the general shape of the mistake catch-up mode invites: it is right
 * that discovery and imports can wait, and wrong that anything on a clock can.
 * Deletes are also writes, and Turso bills rows written either way, so letting
 * a sweep lapse does not even save the quota it appears to.
 *
 * Cheap enough to sit in front of the return: five deletes over indexed
 * columns, gated to once an hour, against a tick that runs every minute.
 */
/**
 * Say where the written rows went.
 *
 * The account was at 110M rows written for a month in which the directory
 * stored 3.3M posts, and nothing in the system could attribute the other 107M.
 * Working it out by reading code and multiplying estimates produced two
 * different wrong answers, which is what an unmeasured quantity does.
 *
 * So the write worker tallies `rowsAffected` per statement shape, and this
 * empties the tally onto the log every ten minutes. The line is a small JSON
 * object rather than one line per shape, so a quiet directory costs one log row
 * and a busy one still costs one.
 *
 * Two numbers matter and the second is the interesting one: `rows` is what the
 * statements themselves report, and the difference between that and Turso's own
 * meter is everything the triggers and indexes wrote underneath them — which,
 * with six FTS triggers in this schema, is the part nobody could see.
 */
function tallyTick() {
  if (!writeWorker) return;

  const tally = takeWriteTally();
  if (tally.totalRows === 0 && tally.totalCalls === 0) return;

  log('write-tally', {
    rows: tally.totalRows,
    statements: tally.totalCalls,
    // Bounded: the long tail is noise next to the shapes doing the damage.
    top: tally.byShape.slice(0, 8).map((s) => `${s.shape}=${s.rows}/${s.calls}`).join(' '),
  });
}

async function purgeTick() {
  if (Date.now() - lastPurge < 3_600_000) return;
  lastPurge = Date.now();

  try {
    const purged = await accounts.purgeExpired(db);
    if (purged) log('purged', { rows: purged });

    // The throughput rollup grows by 24 rows a day forever otherwise, and no
    // chart on the site looks back further than a month.
    const hours = await q.pruneCrawlHours(db);
    if (hours) log('purged-rollup', { rows: hours });

    // The queue samples, on the same terms and for the same reason.
    const queueHours = await q.pruneQueueHours(db);
    if (queueHours) log('purged-queue-rollup', { rows: queueHours });

    // The live log takes a row per feed crawled, so it is the one table here
    // that would grow by six figures a week if nobody swept it — and it has
    // been growing, because this sweep sat behind `catchupOnly` and stopped
    // being reached. Clearing 64 hours of arrears is ~120,000 rows.
    //
    // Slices rather than one statement, and several slices rather than one:
    // each delete stays small enough to finish inside the request deadline
    // while holding the cluster's only writer, and a run still takes a real
    // bite out of the arrears instead of trimming an hour's worth per hour and
    // never catching up. It stops early the moment a slice comes back short,
    // which is what "there is nothing older than the window" looks like.
    let lines = 0;
    for (let slice = 0; slice < 20; slice += 1) {
      const removed = await q.pruneCrawlLog(db);
      lines += removed;
      if (removed < 5000) break;
    }
    if (lines) log('purged-log', { rows: lines });

    // What has already been alerted about. A working set, not a history —
    // nothing consults a row past the re-alert window.
    const told = await alerts.pruneAlertSent(db);
    if (told) log('purged-alerts', { rows: told });
  } catch (err) {
    // A missed sweep is a table that stays large for another hour, which is not
    // a reason to fail a crawl or to shout in a log read for crawl failures.
    log('purge-error', { message: String(err?.message ?? err) });
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
    const filled = await q.backfillClusterKeys(db, clusterBatch);
    if (filled.done) {
      // No unkeyed row left anywhere in the table — which this now genuinely
      // knows, rather than inferring it from having reached the end of a walk.
      // Done for the life of the process; everything stored from here on is
      // keyed as it arrives.
      clusterBackfill = false;
      clearInterval(backfillTimer);
      log('cluster-backfill-done', {});
    } else {
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
  if (!cardEnabled || stopping || carding) return;
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
      concurrency: authorConcurrency,
      githubToken: authorGithubToken,
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

/**
 * Spend a little of the month's search allowance on the unreachable.
 *
 * Guarded twice over. It does nothing without a key, a budget and the switch;
 * and `searchDue` re-reads the ledger every pass, so two pollers or a restarted
 * one cannot between them spend more than the month allows.
 */
let searching = false;

async function searchTick() {
  if (!searchEnabled || !searchApiKey || searchMonthlyBudget <= 0) return;
  if (searching) return;
  searching = true;

  try {
    const result = await searchDue(db, {
      apiKey: searchApiKey,
      monthlyBudget: searchMonthlyBudget,
      perAuthor: searchPerAuthor,
      batchSize: searchBatch,
    });
    // Logged whenever anything was bought, even when it found nothing --
    // especially then. A pass that spends credits and stores no links is the
    // signal that the gate needs tightening, and it is invisible otherwise.
    if (result.spent) log('author-search', result);
  } catch (err) {
    log('author-search-error', { message: String(err?.message ?? err) });
  } finally {
    searching = false;
  }
}

/**
 * Write down how deep each queue is, so /crawlstats can draw the slope.
 *
 * A backlog on its own says almost nothing. Twelve thousand feeds overdue is a
 * crawler falling behind or a crawler halfway through catching up, and those
 * are opposite emergencies that look identical in a count. The difference is
 * the direction it is moving, and nothing was writing that down.
 *
 * Its own timer rather than a line in `tick()`, on the same reasoning as the
 * enrichment pass: a sample missed because the crawl above it was slow leaves a
 * hole in the one series whose job is to show holes.
 *
 * Ten minutes by default. The sample is four counts over `feeds`, all of them
 * on covering indexes, and only the last one in each hour is kept — so this is
 * six cheap reads and one small write an hour, against a chart that is read in
 * hours.
 */
async function queueTick() {
  if (stopping || sampling) return;
  sampling = true;

  try {
    const [backlogs, authors] = await Promise.all([q.jobBacklogs(db), q.countAuthorQueue(db)]);

    await q.recordQueueHour(db, {
      due: backlogs.due,
      firstCrawl: backlogs.pendingFirstCrawl,
      cards: backlogs.cardsPending,
      authors,
    });
  } catch (err) {
    // A missed sample is a gap in a chart, which the chart draws as a gap. It
    // is not a reason to make noise in a log that is read for crawl failures.
    //
    // That was already the intent and the line did the opposite of it, twice
    // over: `toEntry` marks a row as an error when the event name ends in
    // "error" *or* when the fields carry a `message`, and this had both. So a
    // burndown-chart sample that could not be taken went straight onto the
    // panel whose entire job is "is anything broken", next to writes that
    // genuinely did not happen.
    //
    // It is the same mistake as logging every retry attempt as a failed write,
    // and it has the same fix: name it for what it is and carry the reason in a
    // field that is not `message`. The line stays in the stream and in Railway
    // for anyone reading a pattern, and out of the alarm.
    //
    // Worth knowing if this ever needs chasing: since the write moved into the
    // queue it is the *reads* that time out here — four conditional aggregates
    // over 476k feeds, ~1.4s idle, which a busy crawl can push past the
    // 30-second deadline. Nothing is broken when that happens; the chart just
    // misses a point.
    log('queue-sample-missed', { reason: String(err?.message ?? err) });
  } finally {
    sampling = false;
  }
}

/** Guards against a warm that outruns its interval starting a second one. */
let warming = false;

/**
 * Recompute the category breakdown into Redis, so no page has to.
 *
 * This read takes about a minute against half a million feeds and cannot be
 * made cheap: the columns it groups by are rewritten on every crawl, so an
 * index covering them would be paid for on the write path, which is the one
 * thing this system has none of to spare. Doing it here instead costs the
 * crawler nothing -- it is a read, and reads do not queue behind the single
 * writer everything else contends for.
 *
 * `warmStatsCache` never throws; the result is logged rather than acted on,
 * because there is nothing to do about a warm that did not happen except serve
 * the previous answer, which is what the cache already does.
 */
async function statsTick() {
  if (warming) return;
  warming = true;
  try {
    const result = await warmStatsCache({ log });
    if (!result.ok) return;
  } finally {
    warming = false;
  }
}

/**
 * The one process that actually writes to Turso.
 *
 * SQLite permits a single writer, and until now the closest we could get was
 * one writer *per process* — `serializeWrites` queues inside whichever process
 * it is loaded in, so the poller and the web service still contended with each
 * other. The queue now lives in Redis and exactly one consumer drains it, which
 * is the guarantee the storage engine actually wants.
 *
 * It runs here rather than in its own service on purpose. The poller is already
 * the origin of almost every write, so co-locating the worker keeps the common
 * path to one Redis hop, and it means there is no third service to keep alive
 * for the database to be writable. The tradeoff is that a poller outage stops
 * the web service's writes too — which is why the jobs survive the outage in
 * Redis rather than dying with the process, and why the web service degrades to
 * failed writes rather than silent ones.
 *
 * Its client is deliberately unqueued (`queue: false`): this is the consumer,
 * and a queued client here would post every job straight back to itself.
 */
const writeWorker = redisUrl
  ? createWriteWorker(connect({ queue: false }), {
      url: redisUrl,
      onEvent: publishLog ? recorder.record : null,
    })
  : null;

if (writeWorker) {
  // A job that failed every attempt is a write that did not happen, which is
  // exactly the class of failure this daemon exists to make visible.
  //
  // BullMQ emits `failed` once per *attempt*, though, and this handler used to
  // treat all three alike — so the retries that were about to succeed were the
  // loudest thing on the status page. `writeFailure` holds that judgement, and
  // its comment holds the measurements behind it.
  writeWorker.on('failed', (job, err) => {
    const { event, fields } = writeFailure(job, err);
    log(event, fields);
  });
  writeWorker.on('error', (err) => {
    log('write-worker-error', { message: String(err?.message ?? err) });
  });
}

const timer = setInterval(tick, intervalMs);
const backfillTimer = setInterval(backfillTick, clusterIntervalMs);
const cardTimer = setInterval(cardTick, cardIntervalMs);
const alertTimer = setInterval(alertTick, alertIntervalMs);
const enrichTimer = setInterval(enrichTick, authorIntervalMs);
const queueTimer = setInterval(queueTick, queueSampleMs);
const statsTimer = setInterval(statsTick, statsWarmMs);
const searchTimer = setInterval(searchTick, searchIntervalMs);
// Same cadence as the queue sample: long enough that the line is a summary
// rather than a stream, short enough to bracket an experiment against.
const tallyTimer = setInterval(tallyTick, queueSampleMs);
void tick();
void backfillTick();
void cardTick();
void alertTick();
void enrichTick();
void queueTick();
// Run once at boot, so a deploy does not leave the page slow until the first
// interval comes round.
void statsTick();

log('started', {
  intervalSeconds: intervalMs / 1000,
  batchSize,
  concurrency,
  discoveryBatch,
  clusterBackfill,
  cardBatch: cardEnabled ? cardBatch : 0,
  authorBatch: authorEnabled ? authorBatch : 0,
  crawlAutocommit: ['1', 'true'].includes(String(env['TURSO_CRAWL_AUTOCOMMIT'] ?? '').toLowerCase()),
  auxiliaryWrites: !['0', 'false'].includes(String(env['CRAWL_AUXILIARY_WRITES'] ?? '').toLowerCase()),
  catchupOnly,
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
  clearInterval(queueTimer);
  clearInterval(statsTimer);
  clearInterval(searchTimer);
  clearInterval(tallyTimer);

  // Closed gracefully, which for BullMQ means "finish the job in hand, take no
  // more". A write half-applied because the container went away is the one
  // failure a queue is supposed to prevent, and Railway sends SIGTERM on every
  // deploy — so this runs several times a day.
  void writeWorker?.close();

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
