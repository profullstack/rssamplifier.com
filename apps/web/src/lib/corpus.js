import { dataset, authors, remember } from '@rssamplifier/db';

import { db } from './db.js';

/**
 * The figures on /sales, cached the way every other expensive count here is.
 *
 * The page has to carry real numbers — an offer to license a corpus is exactly
 * the page where an invented figure destroys the value of the honest ones — and
 * it is also a page a stranger loads cold. Those two pull against each other,
 * and `remember` is how the rest of this codebase resolves it: compute rarely,
 * serve stale while refreshing, and answer a failed read with a fallback the
 * page can render rather than with an exception.
 *
 * Feed and post counts are not here. They come from `categoryStats`, which
 * /advertise and /crawlstats already pay for and which is the same cache — a
 * second copy of that scan for this page would be the one avoidable cost on it.
 */

/**
 * How long these are trusted before a refresh is started behind the reader.
 *
 * An hour, matching `CATEGORY_TTL_MS`. A corpus does not change shape between
 * two page loads, and the whole point of the pairing is that the value is
 * refreshed by somebody who is not waiting for it.
 */
const TTL_MS = 60 * 60 * 1000;

/**
 * How stale they may get before a reader waits for a fresh one.
 *
 * A month, for the reason `CHART_MAX_STALE_MS` is a month: past this point
 * `remember` stops serving the entry and makes the reader wait out the timeout
 * instead — and then returns the same expired value from its catch anyway. A
 * month-old article count on a sales page is a better answer than a page that
 * hangs.
 */
const MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** Shorter than the client's own deadline, so a hung read gives the page back. */
const TIMEOUT_MS = 8 * 1000;

/**
 * Corpus-specific counts: full-text articles, authors, and publishers opted out.
 *
 * @returns {Promise<{ articles: number, sampledAvgChars: number, sampleSize: number, authors: number, optedOut: number }|null>}
 */
export async function corpusFigures() {
  return remember(
    'corpus:figures',
    { ttlMs: TTL_MS, maxStaleMs: MAX_STALE_MS, timeoutMs: TIMEOUT_MS, fallback: null },
    async () => {
      const client = db();
      const [articles, authorCount, optedOut] = await Promise.all([
        dataset.articleFigures(client),
        authors.countAuthors(client),
        dataset.optedOutCount(client),
      ]);

      return {
        ...articles,
        authors: Number(authorCount ?? 0),
        optedOut: Number(optedOut ?? 0),
      };
    },
  );
}
