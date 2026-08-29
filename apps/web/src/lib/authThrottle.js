/**
 * Escalating per-address backoff for the two ways into an account.
 *
 * ## What this can and cannot defend
 *
 * There are no passwords here — `0003_accounts.sql` has no password column and
 * says why — so there is no "wrong password" to count and nothing to guess by
 * repetition. The two unauthenticated auth surfaces are:
 *
 *   1. asking for a sign-in link (`POST /api/auth/magic`)
 *   2. presenting one (`GET /auth/magic?t=…`)
 *
 * Neither is brute-forceable in the usual sense. A token is `randomBytes(32)`,
 * so guessing one is 2^256 work, and `requestSignInLink` already caps links at
 * five per address per hour. What *is* open is volume from a single caller:
 * the per-address cap does nothing about one host asking for links to ten
 * thousand *different* addresses, which costs real money at the mail provider
 * and puts the sending domain's reputation at risk. That is the hole this
 * closes, and presenting bad tokens is metered on the same counter because it
 * is the closest thing this system has to a failed login.
 *
 * ## Why escalating rather than a fixed window
 *
 * `ratelimit.js` next door is a fixed hourly window, which is right for a public
 * API where the worst case is a noisy crawler. It is the wrong shape here: an
 * abusive caller simply waits out the hour and starts again, at full rate, for
 * ever. Doubling the penalty each time means a caller who keeps going is priced
 * out of continuing — a few minutes, then an hour, then a day — while somebody
 * who tripped it once is forgiven quickly.
 *
 * ## Why in this process's memory
 *
 * Same trade `ratelimit.js` documents and for the same reasons: one web
 * instance sees every request, and the endpoints being protected are exactly
 * the ones that must not grow a database round trip. It matters more than usual
 * right now — the database's write path has spent days unable to commit, and a
 * limiter that needed to write would have been dead precisely when it was
 * wanted. A deploy forgives everyone, which is the right direction to err for a
 * public site.
 */

/** Attempts allowed in a quiet period before the penalty starts. */
const FREE_ATTEMPTS = 5;

/** The first penalty. Doubles with each subsequent trip. */
const BASE_LOCK_MS = 60 * 1000;

/**
 * The ceiling on a single lock.
 *
 * A day, because the point is to make persistence pointless rather than to ban
 * anybody: an address behind a shared NAT can be a whole office, and a
 * permanent block on a public sign-in page would eventually catch a real reader
 * with no way to appeal it.
 */
const MAX_LOCK_MS = 24 * 60 * 60 * 1000;

/**
 * How long a caller must be quiet before its strikes are forgotten.
 *
 * **Must be longer than `MAX_LOCK_MS`**, and that is not a style preference. At
 * six hours against a one-day ceiling, a caller who earned a six-hour lock came
 * back the moment it expired to find its strikes already decayed — so the
 * penalty could never grow past six hours and the ceiling was unreachable. The
 * escalation quietly flattened into a fixed window, which is the thing this was
 * built instead of. Caught by `the penalty is capped`; keep that test.
 *
 * Two days, so waiting out even the longest lock is not by itself enough to be
 * forgiven: a caller must be quiet for a day *beyond* it.
 */
const DECAY_MS = 48 * 60 * 60 * 1000;

/** Same bound, and same reasoning, as `ratelimit.js`: the key space is the internet. */
const MAX_TRACKED = 50_000;

/** @type {Map<string, { strikes: number, lockedUntil: number, lastAt: number }>} */
const seen = new Map();

/**
 * @param {number} now
 */
function sweep(now) {
  for (const [key, entry] of seen) {
    if (entry.lockedUntil <= now && now - entry.lastAt > DECAY_MS) seen.delete(key);
  }

  if (seen.size > MAX_TRACKED) {
    const excess = seen.size - MAX_TRACKED;
    let dropped = 0;
    for (const key of seen.keys()) {
      seen.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * The address a request came from.
 *
 * Railway terminates TLS in front of the app, so the socket peer is a proxy and
 * the caller is the first entry of `x-forwarded-for` — only the first, because
 * everything after it was supplied by whatever sat in between and a caller can
 * write what it likes there.
 *
 * Note the failure mode of getting this wrong: every visitor collapses to one
 * identity and the first five requests in the world lock out everybody.
 *
 * @param {Request} req
 * @returns {string}
 */
export function callerAddress(req) {
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  return first || req.headers.get('x-real-ip') || 'unknown';
}

/**
 * Count one auth attempt and say whether it may proceed.
 *
 * A locked caller is *not* charged another strike for knocking: the penalty
 * escalates once per lock earned, not once per request refused, or a script
 * hammering every second would reach the day-long ceiling in under a minute and
 * a human retrying twice would be treated the same as an attacker.
 *
 * @param {string} identity
 * @param {number} [now] injectable clock, for tests
 * @returns {{ ok: boolean, retryAfter: number, strikes: number, lockedUntil: number }}
 */
export function attempt(identity, now = Date.now()) {
  if (seen.size >= MAX_TRACKED) sweep(now);

  const entry = seen.get(identity) ?? { strikes: 0, lockedUntil: 0, lastAt: now };

  if (entry.lockedUntil > now) {
    entry.lastAt = now;
    seen.set(identity, entry);
    return {
      ok: false,
      retryAfter: Math.max(Math.ceil((entry.lockedUntil - now) / 1000), 1),
      strikes: entry.strikes,
      lockedUntil: entry.lockedUntil,
    };
  }

  // Quiet for long enough: start again rather than carrying a grudge.
  if (now - entry.lastAt > DECAY_MS) entry.strikes = 0;

  entry.strikes += 1;
  entry.lastAt = now;

  if (entry.strikes > FREE_ATTEMPTS) {
    const over = entry.strikes - FREE_ATTEMPTS - 1;
    // Shift rather than Math.pow so a long-lived offender cannot overflow into
    // Infinity before the ceiling applies.
    const lock = Math.min(BASE_LOCK_MS * 2 ** Math.min(over, 40), MAX_LOCK_MS);
    entry.lockedUntil = now + lock;
    seen.set(identity, entry);
    return {
      ok: false,
      retryAfter: Math.max(Math.ceil(lock / 1000), 1),
      strikes: entry.strikes,
      lockedUntil: entry.lockedUntil,
    };
  }

  seen.set(identity, entry);
  return { ok: true, retryAfter: 0, strikes: entry.strikes, lockedUntil: 0 };
}

/**
 * Forget a caller, on proof it was not the thing being defended against.
 *
 * Called when a sign-in link actually works: whoever presented it could read
 * the mailbox, which is the entire security model here, so the attempts that
 * preceded it were somebody fumbling a link rather than an attack.
 *
 * @param {string} identity
 */
export function forgive(identity) {
  seen.delete(identity);
}

/** Forget everyone. Test seam — never call this from a request path. */
export function reset() {
  seen.clear();
}

/** Exposed for tests and for the headers a refusal carries. */
export const LIMITS = { FREE_ATTEMPTS, BASE_LOCK_MS, MAX_LOCK_MS, DECAY_MS };
