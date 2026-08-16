import { connect, migrate, q, accounts } from '@rssamplifier/db';
import {
  crawlDue,
  notifyFinishedSubmissions,
  notifyFinishedDiscoveries,
  drainDiscoveryQueue,
  drainDiscoveryKeywords,
} from '@rssamplifier/ingest';

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

let running = false;
let stopping = false;
let lastPurge = 0;

/**
 * Structured one-line log, so Railway's viewer stays greppable.
 *
 * @param {string} event
 * @param {object} [fields]
 */
function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
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
    const { crawled, failed } = await crawlDue(db, batchSize, concurrency);
    if (crawled || failed) {
      // The backlog is the number worth watching: crawled/failed only say the
      // tick did something, `due` says whether the crawler is keeping up.
      log('crawl', { crawled, failed, ms: Date.now() - started, due: await q.countDueFeeds(db) });
    }

    // A keyword search queues more work than its request could finish, in both
    // phases: keywords still to search, then the sites those searches turn up.
    // Both run after the crawl — an indexed blog going stale matters more than
    // finding a new one.
    const searched = await drainDiscoveryKeywords(db, keywordBatch);
    if (searched.searched || searched.failed || searched.fatal) log('discovery-search', searched);

    const discovered = await drainDiscoveryQueue(db, discoveryBatch);
    if (discovered.checked) log('discovery', discovered);

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
    if (Date.now() - lastPurge > 3_600_000) {
      lastPurge = Date.now();
      const purged = await accounts.purgeExpired(db);
      if (purged) log('purged', { rows: purged });
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

const timer = setInterval(tick, intervalMs);
void tick();

log('started', { intervalSeconds: intervalMs / 1000, batchSize, concurrency, discoveryBatch });

/**
 * Shut down cleanly so Railway's SIGTERM does not sever an in-flight crawl.
 *
 * @param {string} signal
 */
function shutdown(signal) {
  stopping = true;
  clearInterval(timer);
  log('stopping', { signal });

  const deadline = Date.now() + 20_000;
  const wait = setInterval(() => {
    if (!running || Date.now() > deadline) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 250);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
