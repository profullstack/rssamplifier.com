/**
 * Telling apart the four things that go wrong upstream (§16, §40).
 *
 * They look alike from the outside and want opposite responses, which is why
 * they are types rather than strings. Getting this wrong is expensive in a
 * specific way: `markCrawlFailure` walks a backoff ladder and retires a feed at
 * ten consecutive failures, so recording a rate limit as a failure would retire
 * every X source we have within a day of X getting busy — the platform-scale
 * version of the mistake `markThrottled` exists to prevent for ordinary hosts.
 *
 * - **XRateLimited** — come back later. Nothing is broken; the schedule moves
 *   and no health column is touched.
 * - **XAuthFailed** — this *session* is broken. Take it out of rotation and try
 *   another one; the provider and the source are both fine.
 * - **XUnavailable** — this *provider* is broken. Fail over; the source is fine.
 * - **XNoSuchSource** — the account or list does not exist, or is protected.
 *   The only one of the four that is genuinely about the source, and the only
 *   one that should ever count against its health.
 *
 * A protected account is deliberately in the last group and deliberately not
 * retried harder: we do not attempt private timelines (§4, §42).
 */

export class XError extends Error {
  /**
   * @param {string} message
   * @param {{ provider?: string, sessionId?: string, status?: number, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = new.target.name;
    this.provider = meta.provider ?? null;
    this.sessionId = meta.sessionId ?? null;
    this.status = meta.status ?? null;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

export class XRateLimited extends XError {
  /**
   * @param {string} message
   * @param {{ retryAfter?: number|null }} [meta]
   */
  constructor(message, meta = {}) {
    super(message, meta);
    /** Seconds the server asked for, when it said. */
    this.retryAfter = meta.retryAfter ?? null;
  }
}

export class XAuthFailed extends XError {}
export class XUnavailable extends XError {}
export class XNoSuchSource extends XError {}

/**
 * What an HTTP response from an upstream provider means.
 *
 * The status codes are the reliable half. The body sniffing below is the
 * unreliable half and is treated as such — it only ever *upgrades* a generic
 * failure into a specific one, never the reverse, because every unofficial
 * provider phrases these differently and a phrase we do not recognise must
 * still fail safely as "provider unavailable" rather than silently as success.
 *
 * @param {{ status: number, headers?: Headers, body?: string, provider?: string, sessionId?: string }} res
 * @returns {XError|null} null when the response is fine
 */
export function classifyResponse(res) {
  const meta = { provider: res.provider, sessionId: res.sessionId, status: res.status };
  const body = String(res.body ?? '').slice(0, 2000);
  const lower = body.toLowerCase();

  if (res.status === 429) {
    return new XRateLimited('rate-limited', {
      ...meta,
      retryAfter: retryAfterSeconds(res.headers?.get?.('retry-after')),
    });
  }

  if (res.status === 401 || res.status === 403) {
    // 403 is ambiguous on purpose upstream: it is both "your session is no
    // longer valid" and "this account is protected". The body decides, and when
    // it says nothing the session is blamed — because retrying a good session
    // against a protected account costs one wasted request, while retiring a
    // good session costs every source that shares it.
    if (/protected|private account|not authorized to view/.test(lower)) {
      return new XNoSuchSource('protected-account', meta);
    }
    return new XAuthFailed(`auth-failed-${res.status}`, meta);
  }

  if (res.status === 404) return new XNoSuchSource('no-such-source', meta);

  if (res.status === 503 && res.headers?.get?.('retry-after')) {
    return new XRateLimited('unavailable-retry-after', {
      ...meta,
      retryAfter: retryAfterSeconds(res.headers.get('retry-after')),
    });
  }

  if (res.status >= 500 || res.status === 0) {
    return new XUnavailable(`upstream-${res.status}`, meta);
  }

  if (res.status >= 400) return new XUnavailable(`upstream-${res.status}`, meta);

  // A 200 that is really a failure. RSSHub in particular answers 200 with an
  // error document when its own upstream refused, and an unrecognised error
  // page parses to zero items — which the caller would otherwise read as "this
  // account posted nothing", the quietest possible way to lose a feed.
  if (/rate ?limit|too many requests/.test(lower)) {
    return new XRateLimited('rate-limited-body', meta);
  }
  if (/could not authenticate|bad authentication|login required|checkpoint|denied by /.test(lower)) {
    return new XAuthFailed('auth-failed-body', meta);
  }

  return null;
}

/**
 * `Retry-After` in either of its two spellings.
 *
 * @param {string|null|undefined} header
 * @returns {number|null} seconds
 */
export function retryAfterSeconds(header) {
  if (!header) return null;

  const raw = String(header).trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 86_400);

  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;

  return Math.max(0, Math.min(Math.round((when - Date.now()) / 1000), 86_400));
}
