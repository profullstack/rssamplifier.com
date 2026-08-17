import { q, discovery } from '@rssamplifier/db';

import { db } from '../../lib/db.js';
import { categoryStats, indexingHistory, GROWTH_DAYS } from '../../lib/crawlstats.js';
import { toLine } from '../../lib/crawlLog.js';
import { etaLabel, jobRows } from '../../lib/jobs.js';
import AutoRefresh from '../AutoRefresh.jsx';
import { CATEGORIES } from '../CategoryIndex.jsx';
import Toolbar from '../Toolbar.jsx';
import { GrowthChart, IndexingChart, Sparkline, ThroughputChart } from './Charts.jsx';
import CrawlLog from './CrawlLog.jsx';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Crawler status',
  description:
    'Live status of the RSS Amplifier crawler: how many feeds are due, what was fetched in the last hour, and which feeds are failing.',
  robots: { index: true, follow: true },
};

/**
 * What the crawler is doing, right now.
 *
 * /status is a health check for the web service — up or down, nothing else.
 * This is the other question: the web service can be perfectly healthy while
 * the poller has been wedged for six hours and every blog in the directory is
 * quietly going stale. That failure is invisible from outside, so it gets a
 * page.
 *
 * The page refreshes itself every 15 seconds; the same figures are at
 * /api/crawlstats for anything that would rather poll JSON.
 */
export default async function CrawlStatsPage() {
  const client = db();

  const [
    stats,
    failing,
    recent,
    discoveryQueue,
    keywordQueue,
    history,
    categories,
    logTail,
    backlogs,
    activity,
  ] = await Promise.all([
    q.crawlStats(client),
    q.failingFeeds(client, 15),
    q.recentlyCrawled(client, 15),
    discovery.countQueuedCandidates(client),
    discovery.countQueuedKeywords(client),
    indexingHistory(),
    categoryStats(),
    // Rendered into the log so the panel arrives with history rather than
    // waiting for the crawler's next line, and so the log is not blank for a
    // reader with JavaScript off.
    q.crawlLogTail(client, 40),
    // The two halves of the jobs board: what each kind of work has waiting, and
    // what each has been doing. Both are one query, and both are asked here
    // rather than cached — a stale answer about whether a worker is alive is the
    // one thing this page must never give.
    q.jobBacklogs(client),
    q.logActivity(client, 1),
  ]);

  const jobs = jobRows({
    backlogs,
    activity,
    fetchedLastHour: stats.fetchedLastHour,
    keywordQueue,
    candidateQueue: discoveryQueue,
  });

  // The whole directory's curve is the categories' curves added up, which is
  // one array of thirty numbers rather than a seventh query for a total the
  // page is already holding.
  const growth = categories.days.map((_, day) =>
    categories.categories.reduce((n, row) => n + (row.growth[day] ?? 0), 0),
  );

  // A crawler that has fetched nothing in an hour is either idle because
  // nothing was due, or stopped. The backlog tells those apart.
  const idle = stats.fetchedLastHour === 0;
  const health = idle && stats.due > 0 ? 'stalled' : stats.staleActive > 0 ? 'degraded' : 'healthy';

  return (
    <>
      <AutoRefresh seconds={15} />

      <h1>Crawler status</h1>
      <p className="lede">
        Live view of the poller that reads every feed in the directory. Updated automatically; the
        same numbers are available as <a href="/api/crawlstats">JSON</a>.
      </p>

      <p className={`crawl-health crawl-health-${health}`}>
        <strong>{label(health)}</strong>{' '}
        {health === 'stalled'
          ? `${fmt(stats.due)} feeds are due and nothing has been fetched in the last hour.`
          : health === 'degraded'
            ? `${fmt(stats.staleActive)} active feeds have not been read successfully in over a day.`
            : `${fmt(stats.fetchedLastHour)} feeds fetched in the last hour.`}
      </p>

      <div className="stat-grid">
        <Stat label="Feeds" value={fmt(stats.total)} note={`${fmt(stats.active)} active`} />
        <Stat label="Due now" value={fmt(stats.due)} note="waiting to be crawled" />
        <Stat label="Fetched (1h)" value={fmt(stats.fetchedLastHour)} note="crawler throughput" />
        <Stat label="Fetched (24h)" value={fmt(stats.fetchedLastDay)} note={`${fmt(stats.succeededLastDay)} succeeded`} />
        <Stat label="New posts (24h)" value={fmt(stats.itemsLastDay)} note="items ingested" />
        <Stat label="Stale" value={fmt(stats.staleActive)} note="active, no success in 24h" />
        <Stat label="Erroring" value={fmt(stats.errored)} note={`${fmt(stats.dead)} given up`} />
        <Stat label="Pending" value={fmt(stats.pending)} note="accepted, not yet crawled" />
        {/*
         * Discovery shares this poller, so it belongs on this board: a keyword
         * queue that never moves is the same class of silent failure as a crawl
         * backlog that never drains, and it is invisible everywhere else.
         */}
        <Stat label="Keywords queued" value={fmt(keywordQueue)} note="searches not yet run" />
        <Stat label="Sites to check" value={fmt(discoveryQueue)} note="found, not yet resolved" />
      </div>

      <p className="meta">
        Last successful fetch {ago(stats.lastSuccessAt)} · next feed due {due(stats.nextFetchAt)} ·
        generated {new Date(stats.generatedAt).toISOString()}
      </p>

      <h2>Jobs</h2>
      <p>
        One daemon runs all of this, and the numbers above add it up as if it were one queue. It is
        not, and the pieces have opposite shapes: <strong>feed updates</strong> is meant to be deep —
        {' '}
        {fmt(stats.total)} feeds on an hourly interval want more checks per hour than any polite
        crawler makes, so it is permanently behind by design, and the useful figure is how long a
        full pass takes. <strong>First crawls</strong> is the one that should be near empty: feeds
        imported or discovered but never yet read. It has no throughput of its own — it shares the
        update queue and is sorted by the same clock, so an unread feed waits behind everything
        already overdue. A feed added through the submit form is not in it: that path reads the feed
        and stores its posts on the spot.
      </p>

      <table className="crawl-table job-table">
        <thead>
          <tr>
            <th scope="col">Job</th>
            <th scope="col">State</th>
            <th scope="col">Waiting</th>
            <th scope="col">Last hour</th>
            <th scope="col">Clears in</th>
            <th scope="col">Last ran</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.key}>
              <td>
                <strong>{job.label}</strong>
                <span className="job-what">{job.what}</span>
              </td>
              <td>
                <span className={`job-state job-state-${job.state}`}>{job.state}</span>
                {job.errors > 0 && (
                  <span className="job-errors">
                    {fmt(job.errors)} {job.errors === 1 ? 'error' : 'errors'}
                  </span>
                )}
              </td>
              <td className="num">
                {job.backlog == null ? (
                  <span title="Counting these would mean scanning every post on every refresh">
                    not counted
                  </span>
                ) : (
                  fmt(job.backlog)
                )}
                {/* What the job has settled so far, where "waiting" alone would
                    make a long backfill look like it is achieving nothing. */}
                {job.done && <span className="job-what">{job.done}</span>}
              </td>
              <td className="num">
                {job.rate == null ? '—' : fmt(job.rate)}
                {job.rateNote && <span className="job-what">{job.rateNote}</span>}
              </td>
              <td className="num">{etaLabel(job.eta)}</td>
              <td className="num">{ago(job.lastAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Live log</h2>
      <p>
        Every feed the crawler settles, as it settles, plus what each batch did when it finishes.
        The same lines are a log file at{' '}
        <a href="/api/crawlstats/log?format=text">/api/crawlstats/log?format=text</a> — that URL
        keeps being written, so <code>curl -N</code> on it tails the crawler from anywhere.
      </p>

      <CrawlLog src="/api/crawlstats/log" lines={logTail.map(toLine)} />

      <h2>Indexing performance</h2>
      <p>
        What the crawler actually got through, hour by hour, in UTC. The left chart is posts
        stored; the right one is feeds tried, split into the ones that answered and the ones that
        did not. Hover a bar for its numbers, or open the table under either chart.
      </p>

      <div className="chart-row">
        <IndexingChart series={history} />
        <ThroughputChart series={history} />
      </div>

      <h2>By category</h2>
      <p>
        Every feed in the directory is filed under one category, re-read from the feed on each
        crawl — except the three a parser cannot see, which are curated by hand and marked below.
        The curve is the directory as a whole; each row carries its own, at its own scale, because
        a category with tens of thousands of feeds and one with dozens cannot share an axis.
      </p>

      <GrowthChart days={categories.days} values={growth} />

      <table className="crawl-table category-table">
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Feeds</th>
            <th scope="col">Share</th>
            <th scope="col">New (24h)</th>
            <th scope="col">New ({GROWTH_DAYS}d)</th>
            <th scope="col">Posts</th>
            <th scope="col">Erroring</th>
            <th scope="col">Growth ({GROWTH_DAYS}d)</th>
          </tr>
        </thead>
        <tbody>
          {categories.categories.map((row) => {
            const meta = CATEGORIES[row.category];

            return (
              <tr key={row.category}>
                <td className="category-name">
                  {meta ? <a href={meta.path}>{meta.heading}</a> : row.category}
                  {meta?.curated && (
                    <span className="category-flag" title="Curated by hand, not detected">
                      curated
                    </span>
                  )}
                </td>
                <td className="num">{fmt(row.feeds)}</td>
                <td className="num">
                  <Share share={row.share} />
                </td>
                <td className="num">{row.addedLastDay ? `+${fmt(row.addedLastDay)}` : '—'}</td>
                <td className="num">{row.addedLastMonth ? `+${fmt(row.addedLastMonth)}` : '—'}</td>
                <td className="num">{fmt(row.items)}</td>
                <td className="num">{row.errored ? fmt(row.errored) : '—'}</td>
                <td className="spark-cell">
                  <Sparkline
                    values={row.growth}
                    label={`${meta?.heading ?? row.category}: ${fmt(row.growth[0] ?? 0)} feeds ${GROWTH_DAYS} days ago, ${fmt(row.feeds)} now`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td className="category-name">All feeds</td>
            <td className="num">{fmt(categories.total)}</td>
            <td className="num">100%</td>
            <td className="num">
              {sum(categories.categories, 'addedLastDay')
                ? `+${fmt(sum(categories.categories, 'addedLastDay'))}`
                : '—'}
            </td>
            <td className="num">
              {sum(categories.categories, 'addedLastMonth')
                ? `+${fmt(sum(categories.categories, 'addedLastMonth'))}`
                : '—'}
            </td>
            <td className="num">{fmt(sum(categories.categories, 'items'))}</td>
            <td className="num">{fmt(sum(categories.categories, 'errored'))}</td>
            <td />
          </tr>
        </tfoot>
      </table>

      <h2>Recently crawled</h2>
      {recent.length === 0 ? (
        <p>Nothing has been crawled yet.</p>
      ) : (
        <table className="crawl-table">
          <thead>
            <tr>
              <th scope="col">Blog</th>
              <th scope="col">Status</th>
              <th scope="col">Posts</th>
              <th scope="col">Fetched</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((row) => (
              <tr key={String(row.slug)}>
                <td>
                  <a href={`/${String(row.slug)}`}>{String(row.title)}</a>
                </td>
                <td>{String(row.status)}</td>
                <td>{fmt(Number(row.item_count ?? 0))}</td>
                <td>{ago(row.last_fetched_at ? String(row.last_fetched_at) : null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Failing feeds</h2>
      {failing.length === 0 ? (
        <p>No feed is currently failing.</p>
      ) : (
        <table className="crawl-table">
          <thead>
            <tr>
              <th scope="col">Blog</th>
              <th scope="col">Failures</th>
              <th scope="col">Last error</th>
              <th scope="col">Last success</th>
            </tr>
          </thead>
          <tbody>
            {failing.map((row) => (
              <tr key={String(row.slug)}>
                <td>
                  <a href={`/${String(row.slug)}`}>{String(row.title)}</a>
                </td>
                <td>{fmt(Number(row.error_count ?? 0))}</td>
                <td className="crawl-error">{row.last_error ? String(row.last_error) : '—'}</td>
                <td>{ago(row.last_success_at ? String(row.last_success_at) : null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Toolbar />
    </>
  );
}

/**
 * A category's share of the directory, as a number with a bar behind it.
 *
 * The bar is the reason the column exists: 47,000 of 48,000 is a sentence, and
 * a row of them is a shape you can read in one pass.
 *
 * @param {{ share: number }} props
 */
function Share({ share }) {
  const percent = share * 100;

  return (
    <span className="share">
      <span className="share-bar" aria-hidden="true">
        <span className="share-fill" style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }} />
      </span>
      <span className="share-value">
        {percent === 0 ? '0%' : percent < 0.1 ? '<0.1%' : `${percent.toFixed(percent < 10 ? 1 : 0)}%`}
      </span>
    </span>
  );
}

/**
 * @param {object[]} rows
 * @param {string} key
 * @returns {number}
 */
function sum(rows, key) {
  return rows.reduce((n, row) => n + Number(row[key] ?? 0), 0);
}

/**
 * @param {{ label: string, value: string, note?: string }} props
 */
function Stat({ label, value, note }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

/**
 * @param {string} health
 * @returns {string}
 */
function label(health) {
  if (health === 'stalled') return 'Stalled';
  if (health === 'degraded') return 'Degraded';
  return 'Healthy';
}

/**
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

/**
 * How long ago, in words. Absolute timestamps on a page that refreshes itself
 * make the reader do arithmetic to answer "is it moving?".
 *
 * @param {string|null} iso
 * @returns {string}
 */
function ago(iso) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * @param {string|null} iso
 * @returns {string}
 */
function due(iso) {
  if (!iso) return 'nothing scheduled';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'nothing scheduled';

  const seconds = Math.round((then - Date.now()) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  return `in ${Math.round(seconds / 3600)}h`;
}
