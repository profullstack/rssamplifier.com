/**
 * How much of the API one caller may use in an hour.
 *
 * Counted in this process's memory rather than in the database. That is a real
 * trade and it is made deliberately: the site runs as a single web instance, so
 * one process sees every request, and a limiter that writes a row per request
 * would add a database round trip to the very endpoints it exists to protect.
 * If the web app is ever scaled to two instances the effective limit doubles —
 * which is a wrong number, not a broken service, and the fix at that point is a
 * shared counter rather than anything here.
 *
 * The other half of the trade: counters reset when the process restarts, so a
 * deploy forgives everyone. For a limit that exists to stop one crawler from
 * monopolising a shared database — not to meter a paid quota — that is
 * acceptable, and erring towards forgiving is the right direction for a public
 * directory.
 */

/** Fixed window. Simpler than a sliding one and, at these limits, indistinguishable. */
const WINDOW_MS = 3_600_000;

/**
 * Requests an hour for a caller with no key.
 *
 * Generous on purpose. The whole point of this directory is that an agent can
 * read it without asking permission, so the anonymous limit has to be enough to
 * do real work — it is here to stop one runaway loop, not to sell keys.
 */
export const ANONYMOUS_HOURLY = 600;

/** @type {Map<string, { count: number, resetAt: number }>} */
const windows = new Map();

/**
 * Stop the map growing without bound.
 *
 * Every distinct caller creates an entry, so on a public endpoint the key space
 * is the internet. Expired entries are dropped whenever the map gets large,
 * which is cheaper and far more predictable than a timer that runs forever in a
 * process that is mostly idle.
 */
const MAX_TRACKED = 50_000;

/**
 * @param {number} now
 */
function sweep(now) {
  for (const [key, entry] of windows) {
    if (entry.resetAt <= now) windows.delete(key);
  }

  // Still too many live windows: this is a flood of distinct callers rather
  // than a leak. Drop the oldest, which costs those callers a forgiven window.
  if (windows.size > MAX_TRACKED) {
    const excess = windows.size - MAX_TRACKED;
    let dropped = 0;
    for (const key of windows.keys()) {
      windows.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * Count one request against a caller's hourly allowance.
 *
 * @param {string} identity a key id, or an address for anonymous callers
 * @param {number} limit requests permitted per hour
 * @param {number} [now] injectable clock, for tests
 * @returns {{ ok: boolean, limit: number, remaining: number, resetAt: number, retryAfter: number }}
 */
export function consume(identity, limit, now = Date.now()) {
  if (windows.size >= MAX_TRACKED) sweep(now);

  const existing = windows.get(identity);
  const entry =
    existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + WINDOW_MS };

  entry.count += 1;
  windows.set(identity, entry);

  const remaining = Math.max(limit - entry.count, 0);

  return {
    ok: entry.count <= limit,
    limit,
    remaining,
    resetAt: entry.resetAt,
    retryAfter: Math.max(Math.ceil((entry.resetAt - now) / 1000), 1),
  };
}

/**
 * Headers that tell a well-behaved client what its budget is.
 *
 * Sent on every answer, not only on a refusal: a crawler that can see it is
 * running out slows down on its own, and one that only finds out at 429 has
 * already caused the problem.
 *
 * @param {{ limit: number, remaining: number, resetAt: number }} verdict
 * @returns {Record<string, string>}
 */
export function limitHeaders(verdict) {
  return {
    'x-ratelimit-limit': String(verdict.limit),
    'x-ratelimit-remaining': String(verdict.remaining),
    'x-ratelimit-reset': String(Math.ceil(verdict.resetAt / 1000)),
  };
}

/**
 * Forget every window. Test seam — never call this from a request path.
 */
export function reset() {
  windows.clear();
}
