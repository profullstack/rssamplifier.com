import { apikeys } from '@rssamplifier/db';
import { apiKeyFromRequest, looksLikeApiKey, hashToken } from '@rssamplifier/auth';

import { db } from './db.js';

/**
 * The three allowances, and how a request is placed into one.
 *
 * ## The ladder
 *
 * Free callers get an hourly budget. Signing in multiplies it by ten. A
 * sponsor's key lifts it to whatever the server can actually carry. That order
 * is the incentive: the directory stays open to everyone — no key, no account,
 * still answered from the same data with no field withheld — and what money
 * buys is *rate*, never access. `apiguard.js` argued for exactly this shape
 * before any of it was built, and the argument still holds: a metered-but-open
 * API can grow a paid tier by raising a number, where a gated one has already
 * broken every agent that reads this directory today.
 *
 * ## Why an hourly budget on top of the per-minute one
 *
 * `crawlThrottle.js` meters a 60-second window, which is a *burst* control: it
 * stops a caller taking the machine in one second, and it is sized against what
 * a person does. It is not a sustained-rate control. A crawler pacing itself at
 * 119 requests a minute never trips it and still takes 7,200 requests an hour,
 * which is more than the entire site currently serves in that time.
 *
 * So each tier carries both: a burst ceiling per minute, and a budget per hour.
 * A reader browsing hard is bursty and nowhere near the hourly figure; a
 * crawler walking the directory is the reverse. The two together separate them
 * where either alone does not.
 *
 * ## What the numbers mean, and what they are not
 *
 * Requests through the proxy, which includes Next's RSC payload fetches on
 * client navigation — so one page view a reader would recognise is typically
 * two or three of these. The defaults are set with that multiplier in mind and
 * are all overridable, because they were chosen against a single hour of
 * measurement and the honest thing is to make them cheap to change.
 */

/**
 * Read an integer from the environment.
 *
 * Through a non-literal property access: Next inlines `process.env.FOO` at build
 * time, which would bake the build-time value into the Docker image and ignore
 * whatever Railway injects at runtime.
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function envInt(name, fallback) {
  const env = process.env;
  const raw = Number(env[name]);
  // Junk falls back to the default rather than to unlimited. Getting that
  // backwards turns a typo in a dashboard into an open door.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * The free hourly budget: the X the other two tiers are expressed against.
 *
 * 600/hour is ten a minute sustained. Measured against the traffic this actually
 * sees: the whole site runs at roughly 5,200 requests an hour across every
 * caller, a reader browsing steadily sits near 30 a minute in short bursts and
 * far below that averaged, and the crawler this was written for was measured at
 * ~31,000 requests an hour from one address. The line is meant to fall in the
 * wide gap between the two, and it does.
 */
const FREE_HOURLY = envInt('TIER_FREE_HOURLY', 600);

/** Signing in multiplies the budget. The incentive, in one number. */
const AUTH_MULTIPLIER = envInt('TIER_AUTH_MULTIPLIER', 10);

/**
 * The sponsor ceiling: "what the server can handle", written down.
 *
 * Not literally unlimited, deliberately. A runaway loop on a sponsor's key is
 * still a runaway loop, and an unbounded tier means the first bad deploy on a
 * customer's side takes the directory down with it. 120,000/hour is ~33 a
 * second sustained, which is more than twenty times the site's current total
 * load — generous enough to feel like no limit, bounded enough to survive a
 * mistake.
 */
const SPONSOR_HOURLY = envInt('TIER_SPONSOR_HOURLY', 120_000);

/**
 * Burst ceilings, per minute.
 *
 * The free one is unchanged at 120: it was sized against human browsing and
 * that reasoning is untouched by any of this. The higher tiers scale, but far
 * less than their hourly budgets do — a sponsor is buying sustained throughput,
 * not the right to open 1,200 connections in the same second.
 */
export const TIERS = {
  anon: { name: 'anon', burst: envInt('TIER_FREE_BURST', 120), hourly: FREE_HOURLY },
  session: {
    name: 'session',
    burst: envInt('TIER_AUTH_BURST', 300),
    hourly: FREE_HOURLY * AUTH_MULTIPLIER,
  },
  sponsor: { name: 'sponsor', burst: envInt('TIER_SPONSOR_BURST', 2_000), hourly: SPONSOR_HOURLY },
};

/**
 * Validated sponsor keys, by hash, with the time they were checked.
 *
 * @type {Map<string, { ok: boolean, at: number }>}
 */
const keyCache = new Map();

/** How long a verdict about a key is trusted before it is looked up again. */
const KEY_TTL_MS = 5 * 60 * 1000;

/** The key space here is bounded by how many keys exist, but bound it anyway. */
const MAX_KEYS_CACHED = 10_000;

/** @type {Set<string>} in-flight lookups, so a burst does not fan out into one query each */
const pending = new Set();

/**
 * Ask the database about a key, once, in the background.
 *
 * Nothing awaits this. The request that triggered it is already being served at
 * whatever tier the cache could answer for synchronously, and the answer is for
 * the requests after it.
 *
 * @param {string} hash
 * @returns {void}
 */
function refresh(hash) {
  if (pending.has(hash)) return;
  pending.add(hash);

  Promise.resolve()
    .then(() => apikeys.keyByHash(db(), hash))
    .then((key) => {
      if (keyCache.size >= MAX_KEYS_CACHED) keyCache.clear();
      keyCache.set(hash, { ok: Boolean(key), at: Date.now() });
    })
    .catch(() => {
      // Leave the cache alone. An unreachable database means the next request
      // tries again; it must not mean every key silently becomes invalid.
    })
    .finally(() => pending.delete(hash));
}

/**
 * Which allowance this request gets.
 *
 * Synchronous on purpose, and that shapes both branches:
 *
 * **A session is cookie presence only** — no lookup, no validation — exactly as
 * the throttle already decided it. Validating would mean a session query in
 * front of every page in the directory, which is the cost all of this exists to
 * contain. A forged cookie buys the authenticated allowance and nothing else;
 * it reads no data an anonymous caller cannot already read. Note this is a
 * *tightening*: signed-in callers were previously exempt from metering
 * altogether.
 *
 * **A key is answered from cache, and refreshed behind the request.** The first
 * call from a newly-issued key is metered one tier down while the lookup lands,
 * then it settles. That costs a sponsor a few seconds at a lower ceiling once
 * every five minutes, which is a better trade than a database round trip in
 * front of every request on the site. A key that is presented but *known* bad
 * gets the free tier here and a 401 from `apiguard` a moment later, which is
 * where that error belongs.
 *
 * @param {Request} request
 * @returns {{ name: string, burst: number, hourly: number }}
 */
export function tierFor(request) {
  const presented = apiKeyFromRequest(request);

  if (presented && looksLikeApiKey(presented)) {
    const hash = hashToken(presented);
    const cached = keyCache.get(hash);

    if (!cached || Date.now() - cached.at > KEY_TTL_MS) refresh(hash);
    if (cached?.ok) return TIERS.sponsor;
  }

  // `cookies` exists on a NextRequest; a plain Request in a test does not have
  // it, so fall back to reading the header rather than throwing.
  const cookie = /** @type {any} */ (request).cookies?.get?.('rsa_session')?.value;
  if (cookie) return TIERS.session;

  if (/(^|;\s*)rsa_session=[^;]/.test(request.headers.get('cookie') ?? '')) return TIERS.session;

  return TIERS.anon;
}

/** Test seam. @returns {void} */
export function resetTierCache() {
  keyCache.clear();
  pending.clear();
}

/** Test seam: seed a verdict without a database. @returns {void} */
export function primeKey(hash, ok) {
  keyCache.set(hash, { ok, at: Date.now() });
}
