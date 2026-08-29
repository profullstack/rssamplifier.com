/**
 * One entry point for the crawler, whatever the platform is.
 *
 * `crawlFeed` should not grow a branch per network — it already holds three
 * ingestion methods apart (fetch, scrape, collect) and that is the right number.
 * So the choice of collector lives here, and the crawler asks one question:
 * is this row collected rather than fetched?
 *
 * Reddit is deliberately absent. It publishes real RSS, so it is *fetched* like
 * any blog and needs no collector at all — the `/r/` namespace is about naming
 * it, not about reading it. That asymmetry is the whole reason `social_network`
 * and "needs a collector" are two different questions.
 */

import { fetchXSource } from './x/fetch.js';
import { fetchInstagramSource } from './instagram/fetch.js';
import { fetchFacebookSource } from './facebook/fetch.js';

/**
 * The networks that cannot simply be fetched, and what collects them.
 *
 * Adding a platform is an entry here plus a `canonical.js` and a `fetch.js`.
 * It is deliberately not a registry with lifecycle hooks: three collectors that
 * share a return shape are easier to read than a framework that abstracts over
 * two of them.
 */
const COLLECTORS = {
  x: fetchXSource,
  instagram: fetchInstagramSource,
  facebook: fetchFacebookSource,
};

/**
 * Is this row collected through a provider rather than fetched from a document?
 *
 * @param {{ social_network?: string|null }} feed
 * @returns {boolean}
 */
export function isCollected(feed) {
  return Boolean(COLLECTORS[String(feed?.social_network ?? '')]);
}

/**
 * Collect one social source, in the shape `crawlFeed` expects.
 *
 * @param {object} feed the row
 * @param {{ runtime: object, limit?: number, signal?: AbortSignal }} opts
 * @returns {Promise<object>}
 */
export async function fetchSocialSource(feed, opts) {
  const collect = COLLECTORS[String(feed?.social_network ?? '')];
  if (!collect) return { ok: false, error: `no collector for ${feed?.social_network}` };
  return collect(feed, opts);
}
