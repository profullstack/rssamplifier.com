import { q } from '@rssamplifier/db';

import { db } from '../../lib/db.js';
import AutoRefresh from '../AutoRefresh.jsx';
import Toolbar from '../Toolbar.jsx';

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

  const [stats, failing, recent] = await Promise.all([
    q.crawlStats(client),
    q.failingFeeds(client, 15),
    q.recentlyCrawled(client, 15),
  ]);

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
      </div>

      <p className="meta">
        Last successful fetch {ago(stats.lastSuccessAt)} · next feed due {due(stats.nextFetchAt)} ·
        generated {new Date(stats.generatedAt).toISOString()}
      </p>

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
