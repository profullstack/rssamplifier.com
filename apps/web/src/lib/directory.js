import { q, remember } from '@rssamplifier/db';

import { db } from './db.js';

/**
 * The three reads behind the directory index, cached in Redis.
 *
 * ## Why this exists
 *
 * The homepage used to call `listFeeds`, `countFeeds` and `countFeedsByKind`
 * directly in a `Promise.all`, uncached, with no deadline and no fallback. Two
 * of the three are whole-table work at 476,000 feeds, and this module's sibling
 * `crawlstats.js` already documents what they cost: a bare `count(*)` of
 * `feeds` is 6.9 s, and `select category, count(*) … group by category` — which
 * is `countFeedsByKind`, verbatim — exceeds the client's 30 s deadline. When it
 * does, the read throws, nothing catches it, and Next answers the site's most
 * visited URL with a 500.
 *
 * That is not hypothetical and it is not only a bad-day failure. Measured
 * 2026-08-23: `GET /` returned 500 after 30.1 s, thirteen seconds into a
 * `stats-warm` window, then 5.5 s, then 0.24 s once the window passed. The
 * warmer's own scan is what pushes these over the line, so the interval change
 * that goes with this commit removes most of the occasions — but a page whose
 * only behaviour when the database is slow is to 500 will find the next one.
 *
 * ## Why a cache and not a faster query
 *
 * Same trade `crawlstats.js` settled: the columns are `category` and `status`,
 * `status` is rewritten on every crawl, and an index covering it would be paid
 * for on the write path, which is the binding constraint on this database.
 * Buying a fast homepage with a slower crawler is the wrong way round.
 *
 * ## Why one key and not three
 *
 * They are rendered together and they are read together, so one Redis round
 * trip beats three, and the three numbers can never disagree about which
 * moment they describe — a total that does not match the sum of the per-kind
 * counts is the kind of thing a reader notices and nobody can reproduce.
 *
 * ## What the reader sees when it fails
 *
 * `remember` serves the last good answer for up to a day rather than throwing,
 * so a stalled database costs a slightly old count instead of an error page.
 * With nothing cached at all it returns the zero shape below, and the homepage
 * already renders that: it has an explicit empty-directory branch, and the
 * shell around it — search, the submit box, the category index — is worth
 * serving on its own. An empty index for one request beats a 500 for a crawler
 * that will remember it.
 */

/**
 * How long the index is trusted before a refresh is started behind the reader.
 *
 * A minute, matching `HISTORY_TTL_MS` next door. "Recently added" is a list
 * that changes when the crawler admits a feed, not something a visitor is
 * watching tick over, and a burst of readers should cost one scan rather than
 * one each.
 */
const INDEX_TTL_MS = 60 * 1000;

/**
 * How stale it may get before a reader waits for a fresh one.
 *
 * A day, for the reason `CHART_MAX_STALE_MS` is a day: when the underlying read
 * is failing the alternative is not a fresher page, it is no page.
 */
const INDEX_MAX_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Shorter than the client's own 30 s deadline, so a read that is going to hang
 * gives the page back before the browser gives up on it.
 */
const INDEX_TIMEOUT_MS = 20 * 1000;

/** How many blogs the index lists. */
export const INDEX_LIMIT = 60;

/** What a reader gets when nothing has ever been cached and the read fails. */
const EMPTY = { rows: [], total: 0, byKind: {} };

/**
 * Newest blogs, the directory total, and the per-category counts.
 *
 * @returns {Promise<{ rows: object[], total: number, byKind: Record<string, number> }>}
 */
export async function directoryIndex() {
  const value = await remember(
    'directoryIndex',
    {
      ttlMs: INDEX_TTL_MS,
      maxStaleMs: INDEX_MAX_STALE_MS,
      timeoutMs: INDEX_TIMEOUT_MS,
      fallback: null,
    },
    async () => {
      const client = db();
      const [rows, total, byKind] = await Promise.all([
        q.listFeeds(client, { limit: INDEX_LIMIT }),
        q.countFeeds(client),
        q.countFeedsByKind(client),
      ]);
      return { rows, total, byKind };
    },
  );

  // A cached entry predating a shape change, or the fallback, must not be able
  // to take the page down a second way — the caller destructures all three.
  return {
    rows: Array.isArray(value?.rows) ? value.rows : EMPTY.rows,
    total: Number(value?.total ?? 0),
    byKind: value?.byKind && typeof value.byKind === 'object' ? value.byKind : EMPTY.byKind,
  };
}
