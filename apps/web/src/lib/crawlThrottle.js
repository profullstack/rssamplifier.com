/**
 * Escalating backoff for crawl traffic.
 *
 * ## Why this exists, when robots.txt already invites everybody
 *
 * It still does, and that is deliberate — this directory is meant to be read by
 * machines. But an invitation to read is not an invitation to spend the whole
 * machine. Measured on 2026-08-28 over a 3000-request window: ~19.5 req/s, of
 * which essentially none was human. One crawler alone took 54% of all upstream
 * time, at 8.6 req/s sustained, on the most expensive route in the app.
 *
 * So this does not decide *who* may read. It decides *how fast*, and it answers
 * an over-eager caller with 429 and a Retry-After rather than a refusal. A
 * well-behaved crawler reads that and slows down, which is the whole point; the
 * pages stay available to it at a rate that does not crowd out everyone else.
 *
 * ## Why the ceiling is minutes and not a day
 *
 * `authThrottle.js` next door caps a lock at 24 hours, and it is right to: an
 * abusive sign-in caller has no legitimate business being served. A crawler
 * does. Evicting ClaudeBot or GPTBot for a day would cost this directory the
 * indexing it is built to attract, to save an hour of CPU — a bad trade, and
 * the wrong shape of answer. Fifteen minutes is enough that a runaway loop is
 * priced out of continuing while the crawler is back within the hour.
 *
 * ## Why identity is the bot token first, and the address only as a fallback
 *
 * This is the part that decides whether the limiter works at all, and it is not
 * obvious. Per-IP metering catches a crawler that comes from one address and
 * misses one that spreads. From the same measurement:
 *
 *     ClaudeBot            1325 reqs from    1 IP   -> ~31000 req/IP/hr
 *     GPTBot                162 reqs from    1 IP   -> ~3800 req/IP/hr
 *     meta-externalagent    669 reqs from   70 IPs  -> ~224 req/IP/hr
 *     AhrefsBot              67 reqs from   55 IPs  -> ~29 req/IP/hr
 *
 * A per-address limit generous enough not to hurt a person is never reached by
 * the fleets, no matter where it is wired. Keying a *declared* crawler by the
 * token it puts in its own User-Agent collapses its whole fleet into one
 * caller, which is the only way the backoff reaches Meta's seventy addresses.
 *
 * The obvious objection is that a User-Agent is self-reported and a liar can
 * drop the token. True, and it does not matter here: dropping it costs the
 * caller its identity as a known crawler and drops it back to per-address
 * metering, which is exactly where it would have been anyway. Nothing is lost
 * by trusting a claim that only ever tightens the claimant's own budget.
 *
 * What it genuinely cannot reach is a fleet that spoofs a browser — measured
 * here as ~239 addresses on OVH VPSes all presenting one desktop Chrome string
 * at ~71 req/IP/hr. No in-process limiter keyed on anything a request carries
 * will separate that from real readers; that one needs blocking at the edge.
 *
 * ## Why in this process's memory
 *
 * Same trade `ratelimit.js` and `authThrottle.js` document, for the same
 * reasons: one web instance sees every request, and a limiter that wrote a row
 * per request would add a database round trip to every page in the directory —
 * to the very pages whose cost is the thing being contained. A deploy forgives
 * everyone, which for a limiter that exists to shape load rather than to punish
 * is the right direction to err.
 */

/**
 * Requests per identity per window before the penalty starts.
 *
 * Sized against what a *person* does, since the cost of getting it wrong is a
 * reader seeing 429 on a directory that promises to be open. A human reading
 * steadily runs at a few requests a second in bursts and nothing like it
 * sustained; two a second, every second, for a full minute is not browsing.
 * The measured crawlers sit at 8.6 (ClaudeBot) and 4.3 (Meta's fleet, summed)
 * requests a second, so the line falls between the two populations rather than
 * through the middle of either.
 */
const FREE_PER_WINDOW = 120;

/** The window the allowance is counted over. */
const WINDOW_MS = 60 * 1000;

/** The first penalty. Doubles with each subsequent trip. */
const BASE_LOCK_MS = 60 * 1000;

/** The ceiling on a single lock. Minutes, not a day — see the note above. */
const MAX_LOCK_MS = 15 * 60 * 1000;

/**
 * How long a caller must be quiet before its strikes are forgotten.
 *
 * **Must be longer than `MAX_LOCK_MS`**, and `authThrottle.js` paid for that
 * lesson: when decay was shorter than the ceiling, a caller came back the
 * moment its lock expired to find its strikes already cleared, so the penalty
 * could never grow past that point and the escalation quietly flattened into a
 * fixed window. An hour against a fifteen-minute ceiling keeps the ramp real.
 */
const DECAY_MS = 60 * 60 * 1000;

/** Same bound, and same reasoning, as `ratelimit.js`: the key space is the internet. */
const MAX_TRACKED = 50_000;

/**
 * Crawlers that name themselves, lowercased.
 *
 * Only used to *group* a caller's own requests together, never to decide
 * whether it is welcome — every one of these is explicitly invited by
 * `robots.txt` and stays invited. Order does not matter; the first match wins
 * and a caller matching two would be metered under either equally well.
 */
const BOT_TOKENS = [
  'claudebot',
  'anthropic-ai',
  'gptbot',
  'oai-searchbot',
  'chatgpt-user',
  'perplexitybot',
  'meta-externalagent',
  'facebookexternalhit',
  'bytespider',
  'ccbot',
  'amazonbot',
  'applebot',
  'googlebot',
  'google-extended',
  'bingbot',
  'yandexbot',
  'petalbot',
  'ahrefsbot',
  'semrushbot',
  'dataforseobot',
  'mj12bot',
  'dotbot',
  'screaming frog',
];

/** The budget window the tiers are expressed in. See `tiers.js`. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * The default allowance: the per-minute burst this file has always applied, and
 * no hourly budget at all.
 *
 * Unlimited by default so that adding the hourly dimension changed nothing on
 * its own — a caller that does not pass a tier is metered exactly as it was
 * before tiering existed. The proxy passes a real tier; everything else keeps
 * the old behaviour.
 */
const DEFAULT_ALLOWANCE = { burst: FREE_PER_WINDOW, hourly: Infinity };

/** @type {Map<string, { count: number, windowStart: number, hourCount: number, hourStart: number, strikes: number, lockedUntil: number, lastAt: number }>} */
const seen = new Map();

/**
 * @param {number} now
 */
function sweep(now) {
  for (const [key, entry] of seen) {
    if (entry.lockedUntil <= now && now - entry.lastAt > DECAY_MS) seen.delete(key);
  }

  // Still too many live entries: a flood of distinct callers rather than a
  // leak. Drop the oldest, which costs those callers a forgiven window.
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
 * @param {Request} req
 * @returns {string}
 */
export function callerAddress(req) {
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  return first || req.headers.get('x-real-ip') || 'unknown';
}

/**
 * What to meter this caller as.
 *
 * A declared crawler is metered as itself across every address it uses;
 * everything else is metered per address. See the note above for why trusting
 * the claim is safe when the claim only ever narrows the claimant's budget.
 *
 * @param {Request} req
 * @returns {string}
 */
export function callerIdentity(req) {
  const ua = (req.headers.get('user-agent') ?? '').toLowerCase();
  const token = BOT_TOKENS.find((t) => ua.includes(t));
  return token ? `bot:${token}` : `ip:${callerAddress(req)}`;
}

/**
 * Count one request and say whether it may proceed.
 *
 * A locked caller is *not* charged another strike for knocking: the penalty
 * escalates once per lock earned, not once per request refused, or a crawler
 * polling every second would reach the ceiling in seconds while one that
 * retried twice would be treated identically.
 *
 * An exhausted *hourly budget* is handled differently from an exhausted burst:
 * it earns no strike and no escalating lock, and the caller is told exactly how
 * long until its budget rolls over. The distinction is deliberate. A burst is
 * evidence of a caller behaving badly right now, and the doubling penalty is
 * there to make a runaway loop expensive. Spending an hourly allowance is not
 * misbehaviour at all — it is a paying-tier question, and answering it with an
 * escalating punishment would mean a crawler that stays politely at its limit
 * gets treated like one hammering the door.
 *
 * @param {string} identity
 * @param {number} [now] injectable clock, for tests
 * @param {{ burst: number, hourly: number }} [allowance] the caller's tier
 * @returns {{ ok: boolean, retryAfter: number, strikes: number, lockedUntil: number, remaining: number }}
 */
export function attempt(identity, now = Date.now(), allowance = DEFAULT_ALLOWANCE) {
  if (seen.size >= MAX_TRACKED) sweep(now);

  const burst = allowance?.burst ?? FREE_PER_WINDOW;
  const hourly = allowance?.hourly ?? Infinity;

  const entry = seen.get(identity) ?? {
    count: 0,
    windowStart: now,
    hourCount: 0,
    hourStart: now,
    strikes: 0,
    lockedUntil: 0,
    lastAt: now,
  };

  // An entry created before this field existed, or by a caller on the old
  // two-argument path. Treat it as starting its hour now.
  if (entry.hourStart === undefined) {
    entry.hourStart = now;
    entry.hourCount = 0;
  }

  if (entry.lockedUntil > now) {
    entry.lastAt = now;
    seen.set(identity, entry);
    return {
      ok: false,
      retryAfter: Math.max(Math.ceil((entry.lockedUntil - now) / 1000), 1),
      strikes: entry.strikes,
      lockedUntil: entry.lockedUntil,
      remaining: 0,
    };
  }

  // Quiet for long enough: start again rather than carrying a grudge.
  if (now - entry.lastAt > DECAY_MS) entry.strikes = 0;

  // A fresh window: the allowance is a rate, not a lifetime total.
  if (now - entry.windowStart >= WINDOW_MS) {
    entry.windowStart = now;
    entry.count = 0;
  }

  // The same, an hour at a time. A rolling window per caller rather than a
  // wall-clock hour, so a budget cannot be spent twice by straddling :59.
  if (now - entry.hourStart >= HOUR_MS) {
    entry.hourStart = now;
    entry.hourCount = 0;
  }

  entry.count += 1;
  entry.hourCount += 1;
  entry.lastAt = now;

  // Budget before burst: a caller that has spent its hour should be told that,
  // not handed an escalating lock that says it is being punished for speed.
  if (entry.hourCount > hourly) {
    seen.set(identity, entry);
    return {
      ok: false,
      retryAfter: Math.max(Math.ceil((entry.hourStart + HOUR_MS - now) / 1000), 1),
      strikes: entry.strikes,
      lockedUntil: 0,
      remaining: 0,
    };
  }

  if (entry.count > burst) {
    entry.strikes += 1;
    // Shift rather than Math.pow so a long-lived offender cannot overflow into
    // Infinity before the ceiling applies.
    const lock = Math.min(BASE_LOCK_MS * 2 ** Math.min(entry.strikes - 1, 40), MAX_LOCK_MS);
    entry.lockedUntil = now + lock;
    seen.set(identity, entry);
    return {
      ok: false,
      retryAfter: Math.max(Math.ceil(lock / 1000), 1),
      strikes: entry.strikes,
      lockedUntil: entry.lockedUntil,
      remaining: 0,
    };
  }

  seen.set(identity, entry);
  return {
    ok: true,
    retryAfter: 0,
    strikes: entry.strikes,
    lockedUntil: 0,
    // Whichever allowance is closer to running out, since that is the one the
    // caller will actually meet.
    remaining: Math.min(burst - entry.count, hourly - entry.hourCount),
  };
}

/** Forget everyone. Test seam — never call this from a request path. */
export function reset() {
  seen.clear();
}

/** Exposed for tests and for the headers a refusal carries. */
export const LIMITS = {
  FREE_PER_WINDOW,
  WINDOW_MS,
  HOUR_MS,
  BASE_LOCK_MS,
  MAX_LOCK_MS,
  DECAY_MS,
  BOT_TOKENS,
};
