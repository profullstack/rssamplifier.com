/**
 * The one function the crawler calls, and the only one it needs.
 *
 * `crawlFeed` already knows how to hold two ingestion methods apart — a feed it
 * fetches and parses, and a page it scrapes — and both hand back the same
 * shape: `{ ok, feedUrl, feed }`, or a failure that says whether it was a
 * throttle. This returns that same shape from a stack of X providers, which is
 * what lets an X source travel every line of the existing pipeline: dedupe,
 * interval learning, keyword extraction, author credit, FTS, alerts, sitemaps.
 *
 * The alternative — the `sources` and `items` tables the PRD sketches in §20 —
 * would be a second copy of all of that, and §30's "topic code must not contain
 * X-specific provider logic" would then be a rule to enforce rather than a
 * property of the design.
 *
 * **A failure here never empties a feed.** Nothing in this file deletes an item,
 * and `crawlFeed` writes items only on success, so an outage leaves yesterday's
 * posts exactly where they were and the public route keeps serving them (§40,
 * AC-5). That is the whole of the stale-cache fallback: there is no cache to
 * fall back to, because the database was always the thing being served.
 */

import { xSpecFromRef } from './canonical.js';
import { normalizeXFeed } from './normalize.js';
import { XRegistry } from './registry.js';
import { XSessionPool, sessionsFromEnv } from './sessions.js';

/**
 * How long to wait after an anomaly, in minutes. Long enough that a hundred
 * queued sources do not all rediscover the same upstream problem inside a tick,
 * short enough that a real recovery is picked up within the hour.
 */
const ANOMALY_MINUTES = 20;

/**
 * Build the runtime once, at boot.
 *
 * The registry and the pool both carry state that only means something when it
 * accumulates — a provider's failure streak, a session's cooldown — so a fresh
 * one per crawl would be a system with no memory, rediscovering every outage on
 * every feed.
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   providerStore?: object,
 *   sessionStore?: object,
 *   onEvent?: (event: string, fields: object) => void,
 * }} [opts]
 */
export async function createXRuntime(opts = {}) {
  const env = opts.env ?? process.env;

  const registry = new XRegistry({ env, store: opts.providerStore ?? null });
  const sessions = new XSessionPool(sessionsFromEnv(env), {
    store: opts.sessionStore ?? null,
    cooldownSeconds: Number(env.X_SESSION_COOLDOWN_SECONDS) || undefined,
  });

  await Promise.all([registry.hydrate(), sessions.hydrate()]);

  return { registry, sessions, onEvent: opts.onEvent ?? (() => {}) };
}

/**
 * Is the X integration switched on at all?
 *
 * `X_ENABLED=false` is the kill switch §42 asks for: it stops collection dead
 * without touching a route, so every existing `/x/…` feed keeps serving what it
 * already has and nothing new is fetched.
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function xEnabled(env = process.env) {
  return String(env.X_ENABLED ?? 'false').toLowerCase() !== 'false';
}

/**
 * Collect one X source, in the shape `crawlFeed` expects.
 *
 * @param {{
 *   social_ref?: string, feed_url?: string, social_config?: string|null,
 *   item_count?: number,
 * }} feed the row
 * @param {{
 *   runtime: Awaited<ReturnType<typeof createXRuntime>>,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{ ok: boolean, feedUrl?: string, feed?: object, error?: string,
 *   throttled?: boolean, retryAfter?: number|null }>}
 */
export async function fetchXSource(feed, opts) {
  const spec = xSpecFromRef(feed?.social_ref);
  if (!spec) return { ok: false, error: 'invalid-x-ref' };

  const { registry, sessions, onEvent } = opts.runtime;
  const config = readConfig(feed?.social_config);

  let result;
  try {
    result = await registry.fetch(
      {
        mode: spec.mode,
        username: spec.username,
        query: spec.query,
        listId: spec.listId,
        limit: opts.limit ?? 50,
      },
      { sessions, onEvent, signal: opts.signal },
    );
  } catch (error) {
    // **Exactly one kind of failure is about the source.** A deleted, suspended
    // or protected account is a fact about the account; everything else — a rate
    // limit, a provider outage, a dead session, no provider configured at all —
    // is a fact about us or about the upstream, and recording it against the
    // account is how a directory deletes itself.
    //
    // The arithmetic, because it is what makes this urgent rather than tidy:
    // `markCrawlFailure` retires a feed at ten consecutive failures, and an X
    // source polls on a five-minute floor. Ten strikes is **fifty minutes**. So
    // switching X on before a provider is reachable — which is the ordinary
    // order of operations, since the flag is how you find out — would quietly
    // mark every X source dead within the hour, and nothing in the logs would
    // say "no provider configured" rather than "these accounts are broken".
    //
    // Returning `throttled` routes to `markThrottled`, which moves
    // `next_fetch_at` and leaves `status`, `error_count`, `last_error` and
    // `last_success_at` exactly as they were — the same treatment an ordinary
    // publisher's 429 gets, and for the same reason (§16, §40).
    if (error?.name === 'XNoSuchSource') {
      return { ok: false, error: String(error?.message ?? 'no-such-source').slice(0, 200) };
    }

    return {
      ok: false,
      throttled: true,
      retryAfter: retryAfterFor(error),
      error: String(error?.message ?? 'x-fetch-failed').slice(0, 200),
    };
  }

  const posts = result.posts ?? [];

  // An account that has always been empty is a real thing; an account that had
  // posts yesterday and none today is almost always an upstream that answered
  // 200 with a page it could not fill. The second is treated as a throttle
  // rather than as news, because believing it would let one bad response
  // decide, through the content signature, that this feed is now unchanging
  // and worth crawling once a day (§16, "empty-result anomalies").
  if (posts.length === 0 && Number(feed?.item_count ?? 0) > 0) {
    onEvent('x.fetch.failed', { provider: result.provider, error: 'empty-result' });
    return { ok: false, throttled: true, retryAfter: ANOMALY_MINUTES * 60, error: 'empty-result' };
  }

  return {
    ok: true,
    feedUrl: feed.feed_url,
    feed: normalizeXFeed(posts, {
      spec,
      url: String(feed.feed_url),
      includeReplies: config.includeReplies,
      includeReposts: config.includeReposts,
      includeQuotes: config.includeQuotes,
      displayName: result.displayName ?? null,
      avatarUrl: result.avatarUrl ?? null,
    }),
  };
}

/**
 * How long to wait before trying this source again, by what went wrong.
 *
 * The three intervals are three different guesses about when the situation
 * changes. A rate limit usually names its own; a provider outage is minutes;
 * and "no provider is configured" is a deployment that has not happened yet, so
 * asking again in ten minutes is a thousand pointless wake-ups a day across the
 * directory and answers no sooner than asking in an hour.
 *
 * @param {Error & { retryAfter?: number|null }} error
 * @returns {number} seconds
 */
function retryAfterFor(error) {
  if (error?.name === 'XRateLimited') {
    return Number(error.retryAfter) > 0 ? Number(error.retryAfter) : ANOMALY_MINUTES * 60;
  }
  // Nothing is set up to collect with. Distinguished by message rather than by
  // type because `XUnavailable` covers both this and a provider that is merely
  // down, and the two deserve very different patience.
  if (/no X provider is configured/i.test(String(error?.message ?? ''))) return 3600;

  return ANOMALY_MINUTES * 60;
}

/**
 * The per-source toggles of §6.3, with the PRD's defaults.
 *
 * Applied while the collected posts are turned into items, which means they
 * decide what is *stored*: a source with `includeReposts: false` never has a
 * repost in `feed_items`, and changing the toggle takes effect from the next
 * crawl rather than retroactively.
 *
 * That is a deliberate limitation and the alternative was considered. Storing
 * everything and filtering at render would let one row serve both a with- and a
 * without-reposts view, but only if `feed_items` carried a column saying which
 * items were reposts — a schema change for a toggle almost nobody moves, on the
 * largest table in the database. Replies, the one split that people do want
 * both of, do not need it: `/x/:user` and `/x/:user/replies` are different refs
 * and therefore different rows, so both exist at once.
 *
 * @param {string|null|undefined} raw
 */
export function readConfig(raw) {
  const defaults = { includeReplies: false, includeReposts: true, includeQuotes: true };
  if (!raw) return defaults;

  try {
    const parsed = JSON.parse(String(raw));
    return {
      includeReplies: parsed?.includeReplies ?? defaults.includeReplies,
      includeReposts: parsed?.includeReposts ?? defaults.includeReposts,
      includeQuotes: parsed?.includeQuotes ?? defaults.includeQuotes,
    };
  } catch {
    return defaults;
  }
}
