import { q, discovery, alerts } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';
import { categoryStats, indexingHistory } from '../../../lib/crawlstats.js';
import { toLine } from '../../../lib/crawlLog.js';
import { jobRows } from '../../../lib/jobs.js';

export const dynamic = 'force-dynamic';

/**
 * Crawler status as JSON.
 *
 * The page at /crawlstats renders the same numbers; this is the version a
 * monitor can poll. `stale` and `due` are the two worth alerting on: `due` is a
 * backlog that should drain within a tick or two, `stale` is active feeds the
 * crawler has not successfully read in a day.
 *
 * Deliberately uncached — a status endpoint that answers from a cache reports
 * that everything was fine a minute ago, which is the one thing it must not do.
 * The two additions that are cached, briefly, are the ones nothing would alert
 * on: the hourly history and the category breakdown. See lib/crawlstats.js.
 */
export async function GET() {
  const client = db();

  const [
    stats,
    failing,
    recent,
    sitesToCheck,
    keywordsQueued,
    history,
    categories,
    backlogs,
    activity,
    alertAccounts,
    operationalErrors,
  ] = await Promise.all([
    q.crawlStats(client),
    q.failingFeeds(client, 20),
    q.recentlyCrawled(client, 20),
    discovery.countQueuedCandidates(client),
    discovery.countQueuedKeywords(client),
    indexingHistory(),
    categoryStats(),
    q.jobBacklogs(client),
    q.logActivity(client, 1),
    // See the page: this only tells a sender with nobody to serve from one that
    // has stopped, which the log alone cannot say.
    alerts.alertingAccountCount(client),
    q.crawlOperationalErrors(client, { limit: 20, hours: 24 }),
  ]);

  const jobs = jobRows({
    backlogs,
    activity,
    fetchedLastHour: stats.fetchedLastHour,
    keywordQueue: keywordsQueued,
    candidateQueue: sitesToCheck,
    alertAccounts,
  });

  return new Response(
    JSON.stringify(
      {
        ...stats,
        // Where to watch the same crawler line by line rather than in
        // aggregate. Named here because this is the endpoint an agent finds
        // first, and a stream nobody knows about is a stream nobody reads.
        log: { events: '/api/crawlstats/log', text: '/api/crawlstats/log?format=text' },
        // The discovery queues run on the same poller, so a monitor watching
        // this endpoint should see them stall too.
        discovery: { keywordsQueued, sitesToCheck },
        // The same work, split by job. This is the shape to alert on rather than
        // the totals above: `due` is one queue that is meant to be deep, and a
        // monitor built on it either pages constantly or never. A job whose
        // state is 'stalled' is work waiting with nothing working on it, which is
        // the condition worth waking somebody for.
        jobs: jobs.map((job) => ({
          key: job.key,
          label: job.label,
          what: job.what,
          state: job.state,
          backlog: job.backlog,
          ratePerHour: job.rate,
          errorsLastHour: job.errors,
          clearsInHours: job.eta == null ? null : Math.round(job.eta * 10) / 10,
          lastRanAt: job.lastAt,
        })),
        // Daemon/background failures are separate from per-feed failures. A
        // monitor should not have to tail a rolling stream to learn that the
        // database writer or a maintenance job is timing out.
        operationalErrors: operationalErrors.map(toLine),
        // What the directory holds, and how that has moved. `growth` is
        // cumulative and aligned to `days`, so the two zip into a series
        // without the caller having to reconstruct anything.
        categories: {
          total: categories.total,
          days: categories.days,
          breakdown: categories.categories,
        },
        // Throughput hour by hour, oldest first. `recorded: false` means the
        // hour predates the rollup: its item count is real, its crawl counts
        // are not zero but unknown.
        indexing: history,
        failing: failing.map((row) => ({
          slug: String(row.slug),
          title: String(row.title),
          status: String(row.status),
          errorCount: Number(row.error_count ?? 0),
          lastError: row.last_error ? String(row.last_error) : null,
          lastFetchedAt: row.last_fetched_at ? String(row.last_fetched_at) : null,
          lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
        })),
        recent: recent.map((row) => ({
          slug: String(row.slug),
          title: String(row.title),
          status: String(row.status),
          itemCount: Number(row.item_count ?? 0),
          lastFetchedAt: row.last_fetched_at ? String(row.last_fetched_at) : null,
        })),
      },
      null,
      2,
    ),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        // The directory is open to agents by design, and a status endpoint is
        // the most useful thing to be able to read from anywhere.
        'access-control-allow-origin': '*',
      },
    },
  );
}
