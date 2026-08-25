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
 * An hour, matching `CATEGORY_TTL_MS` next door, and raised from a minute on
 * 2026-08-25 because a minute was costing far more than it bought.
 *
 * Two of the three reads behind this key visit every row of a 476,000-feed
 * table, so each refresh is ~0.5M rows read. At a one-minute TTL that is a full
 * scan every minute of every day, whether or not anybody asked for one — and
 * `robots.txt` deliberately welcomes every AI crawler, so somebody always is.
 * That is how the org reached 83.8 *billion* rows read in a month (84% of the
 * Turso quota) and 123% of the write quota, which wedged the write path and
 * stopped the crawler dead for 38 hours.
 *
 * An hour is honest about what the numbers do rather than generous: the
 * directory took on 320,000 feeds in a day back in August, but discovery has
 * since settled to **single digits per day**. A count that moves by ten a day
 * does not need re-deriving sixty times an hour, and "recently added" is a list
 * a visitor reads, not one they watch tick over.
 */
const INDEX_TTL_MS = 60 * 60 * 1000;

/**
 * How stale it may get before a reader waits for a fresh one.
 *
 * Effectively never, and that is a deliberate change from a day.
 *
 * `maxStaleMs` reads like a safety net and behaves like a cliff. Past it,
 * `remember` takes its "nothing usable cached" branch: the reader blocks for
 * the whole of `INDEX_TIMEOUT_MS`, the recompute fails — `countFeedsByKind` is
 * a `group by` over every row and cannot finish inside twenty seconds — and the
 * catch then returns `entry.value`, *the same expired value it would have
 * served instantly*. So the wait buys the reader nothing and cannot ever renew
 * the entry, which means the next reader pays it too. Measured 2026-08-25: `/`
 * answered 200 in 20.35 s on five consecutive requests, for ever.
 *
 * The three numbers here are a directory count, a per-category breakdown and a
 * list of recent blogs. None of them is a liveness signal — nothing here can
 * make a dead crawler look alive, which is the one thing `crawlstats.js` guards
 * with a short ceiling. So an old answer served now is strictly better than the
 * same old answer served twenty seconds from now, however old it gets.
 *
 * A month rather than `Infinity` on purpose: `writeEntry` stores with
 * `PX: maxStaleMs * 2`, and `Infinity` is not a value Redis will accept — the
 * `set` would throw, be swallowed by that function's catch, and the entry would
 * never be stored at all, which is the exact failure this constant exists to
 * prevent. Redis is the real ceiling anyway: a background `refresh` writes with
 * a 48-hour expiry, so "a month" means "for as long as Redis still has it".
 */
const INDEX_MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;

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
