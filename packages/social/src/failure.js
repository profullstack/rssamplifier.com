/**
 * What a collection failure means for the source, for every platform at once.
 *
 * This exists because the rule is easy to state, easy to get wrong, and
 * expensive when it is: **only a source that does not exist may count against
 * the source.** Everything else — a rate limit, a provider outage, a dead
 * session, nothing configured to collect with — is a fact about us or about the
 * upstream.
 *
 * `markCrawlFailure` retires a feed at ten consecutive failures, and a
 * provider-collected source polls on a five-minute floor. Ten strikes is fifty
 * minutes. PR #157 was written because that rule was implemented once, for X,
 * and implemented wrongly; the fix belongs in one place rather than being
 * rediscovered by each new platform. Instagram and Facebook were added against
 * this function rather than against a copy of X's version of it.
 */

/**
 * How long to wait after an upstream anomaly, in seconds.
 *
 * Long enough that a hundred queued sources do not each rediscover the same
 * outage inside one tick; short enough that a real recovery is picked up within
 * the hour.
 */
export const ANOMALY_SECONDS = 20 * 60;

/**
 * And after "there is nothing configured to collect with", which is a
 * deployment that has not happened rather than a service that is down. Asking
 * again in twenty minutes answers no sooner than asking in an hour, and costs a
 * thousand pointless wake-ups a day across the directory.
 */
export const UNCONFIGURED_SECONDS = 3600;

/**
 * Turn a thrown collection error into the result `crawlFeed` expects.
 *
 * @param {Error & { name?: string, retryAfter?: number|null }} error
 * @returns {{ ok: false, error: string, throttled?: true, retryAfter?: number }}
 */
export function failureResult(error) {
  const message = String(error?.message ?? 'collect-failed').slice(0, 200);

  // The one failure that is genuinely about the source: deleted, suspended,
  // renamed, or protected. This is the only path to markCrawlFailure.
  if (error?.name === 'XNoSuchSource') return { ok: false, error: message };

  return { ok: false, throttled: true, retryAfter: retryAfterFor(error), error: message };
}

/**
 * @param {Error & { name?: string, retryAfter?: number|null }} error
 * @returns {number} seconds
 */
export function retryAfterFor(error) {
  if (error?.name === 'XRateLimited') {
    const named = Number(error.retryAfter);
    return named > 0 ? named : ANOMALY_SECONDS;
  }

  // Distinguished by message rather than by type, because `XUnavailable` covers
  // both "nothing is configured" and "the thing that is configured is down",
  // and those deserve very different patience.
  if (/no .* provider is configured|no RSSHUB_BASE_URL|not connected/i.test(String(error?.message ?? ''))) {
    return UNCONFIGURED_SECONDS;
  }

  return ANOMALY_SECONDS;
}
