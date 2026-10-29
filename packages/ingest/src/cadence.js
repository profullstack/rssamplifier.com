import { createHash } from 'node:crypto';
import { planNext } from '@profullstack/scraper-daemon/cadence';

/**
 * How often a feed is worth re-reading, judged by how often it actually posts.
 *
 * The scheduler this replaces doubled a silent feed's gap and capped it at one
 * day. That cap is the whole problem at directory scale: a podcast whose last
 * episode went out in 2024 was still being fetched **every single day, for
 * ever**, and so was every other abandoned feed. Sampling 400 active feeds in
 * production:
 *
 *     posted within 7 days   11.8%
 *     7-30 days              13.0%
 *     1-3 months             17.3%
 *     3-12 months            33.3%
 *     1-2 years               8.8%
 *     over 2 years           15.8%   <- fetched daily under the old ladder
 *
 * Three quarters of the directory had not posted in a month, a quarter had not
 * posted in a year, and the measured `fetch_interval_minutes` was p50 60 / max
 * 240 — meaning nearly everything was still on the hourly floor. That is
 * ~62,700 crawls an hour demanded against a measured capacity near 2,000: 31x
 * oversubscribed, which is why the backlog sat at 368k and could not fall. No
 * amount of making a crawl cheaper fixes a 31x oversubscription; the crawls
 * have to stop being asked for.
 *
 * The signal used here is the feed's own rhythm rather than merely how long it
 * has been silent, because those are different questions and only one of them
 * is useful. A daily newspaper and a blog that happened to post yesterday look
 * identical by recency; by rhythm the newspaper wants checking daily and the
 * blog does not. Both numbers come out of the document the crawl already
 * parsed, so the whole calculation costs **no extra round trip** — which
 * matters more here than usual, since a round trip is the unit this crawler is
 * short of.
 */

/** Never re-read a feed more often than this, however fast it posts. */
export const MIN_INTERVAL = 60;

/**
 * The floor for a feed whose own dates say it posts more often than hourly.
 *
 * Dates are the publisher's evidence and the strongest we get, so a feed that
 * demonstrably posts every half hour is read every fifteen minutes. Undated and
 * change-log feeds keep MIN_INTERVAL: what we observe ourselves is only as fine
 * as how often we looked, and they are 44% of the demand.
 */
export const DATED_MIN_INTERVAL = 15;

/**
 * The floor for a source we collect through a provider rather than fetch.
 *
 * An hour is the right floor for the open web: a blog post that appears
 * fifty-five minutes late is not late, and the floor is what stops 368,000
 * feeds from being asked more often than they can possibly have changed.
 *
 * A timeline is the one thing in this directory where it is plainly wrong.
 * §17 asks for five minutes on an active source and that is what a reader
 * expects of a social feed — an hour-old timeline reads as broken rather than
 * as cached. It is affordable for the same reason it would not be for the
 * directory at large: there are dozens of X sources, not hundreds of thousands,
 * and one upstream refresh serves every subscriber to it (§39).
 *
 * Every function below takes this as a parameter rather than reading it, so the
 * floor is a property of the *source* and there is exactly one place — the
 * crawl — that decides which one a given row gets.
 */
export const SOCIAL_MIN_INTERVAL = 5;

/**
 * Never wait longer than this, however dead a feed looks.
 *
 * Ninety days rather than never, because "abandoned" is a guess and a wrong
 * guess is permanent otherwise: blogs come back, a domain changes hands, and a
 * feed we stopped reading entirely is one we would never notice had returned.
 * Four checks a year is close enough to free — at 368k feeds it is about 4,000
 * crawls a day for the whole long tail — and it keeps the directory honest.
 */
export const MAX_INTERVAL = 129_600; // 90 days

/**
 * How many of a document's dates to consider.
 *
 * A feed carries its recent window and that window is exactly the right sample:
 * what matters is the rhythm now, not the rhythm in 2019. Capped anyway so an
 * archive feed shipping four thousand entries does not turn scheduling into a
 * sort of four thousand dates on every crawl.
 */
const SAMPLE = 30;


/**
 * The dates a document actually carries, cleaned.
 *
 * Anything unparseable, absent, or in the future is dropped rather than
 * guessed at. A feed that stamps tomorrow on every entry — and they exist —
 * would otherwise read as permanently fresh and be polled at the floor for
 * ever, which is the failure this whole module is about.
 *
 * @param {Array<{ publishedAt?: unknown }>} items
 * @param {number} now epoch ms
 * @returns {number[]}
 */
export function publishedTimes(items, now = Date.now()) {
  const out = [];
  for (const item of items ?? []) {
    const raw = item?.publishedAt;
    if (raw === null || raw === undefined || raw === '') continue;
    const t = Date.parse(String(raw));
    if (!Number.isFinite(t)) continue;
    // A little slack for clock skew between us and the publisher; a date more
    // than a day ahead is a broken feed, not a fast one.
    if (t > now + 86_400_000) continue;
    out.push(t);
  }
  return out.sort((a, b) => b - a).slice(0, SAMPLE);
}

/**
 * How long to wait before reading this feed again.
 *
 * Falls back to the old doubling ladder whenever the document gives it nothing
 * to work with — an undated feed is common on the small web and must not be
 * punished for it, so it keeps the behaviour it had before this existed.
 *
 * @param {object} input
 * @param {Array<{ publishedAt?: unknown }>} [input.items] the document just parsed
 * @param {number} [input.newItems] posts this crawl actually stored
 * @param {number} [input.currentMinutes] the feed's existing interval
 * @param {number} [input.now] epoch ms, injectable for tests
 * @returns {number} minutes, between MIN_INTERVAL and MAX_INTERVAL
 */
export function nextInterval({ items = [], newItems = 0, currentMinutes = MIN_INTERVAL, now = Date.now() } = {}) {
  const dated = intervalFromDates(items, now);
  if (dated !== null) return dated;

  // Nothing dated to reason about. Keep the previous behaviour exactly: a feed
  // that just published drops to the floor, one that did not doubles. The old
  // one-day ceiling is kept for this branch on purpose — without dates there is
  // no evidence a feed is abandoned, only that it is quiet, and 90 days is too
  // strong a conclusion to draw from no data.
  if (newItems > 0) return MIN_INTERVAL;
  const current = Number(currentMinutes) || MIN_INTERVAL;
  return clamp(Math.max(current, MIN_INTERVAL) * 2, MIN_INTERVAL, 1440);
}

/**
 * The most recent believable publication date in a document, as an ISO string.
 *
 * Stored on the feed row so that "is this publisher still publishing" can be
 * answered without touching feed_items — see migration 0030. It reuses
 * `publishedTimes`, so a feed stamping tomorrow on every entry cannot make
 * itself look freshly published here either.
 *
 * @param {Array<{ publishedAt?: unknown }>} items
 * @param {number} [now] epoch ms
 * @returns {string|null} null when the document carries no believable date
 */
export function newestPublished(items, now = Date.now()) {
  const times = publishedTimes(items, now);
  return times.length === 0 ? null : new Date(times[0]).toISOString();
}

/**
 * The interval a document's own dates imply, or null if they imply nothing.
 *
 * Split out from `nextInterval` because of *when* the two can be answered. This
 * half depends only on the document that has just been parsed, so the crawl can
 * settle the schedule in the same write that stores the items — and on this
 * database a saved write transaction is the whole game. The other half needs to
 * know how many posts were actually stored, which is not known until that write
 * has happened, so it stays where it can be evaluated in SQL.
 *
 * Returning null rather than a default is the point: it is the caller's signal
 * that the dates had nothing to say and the old doubling ladder should decide.
 *
 * @param {Array<{ publishedAt?: unknown }>} items
 * @param {number} [now] epoch ms
 * @returns {number|null} minutes, or null when the document carries fewer than
 *   two believable dates
 */
export function intervalFromDates(items, now = Date.now(), floor = MIN_INTERVAL) {
  const times = publishedTimes(items, now);
  if (times.length < 2) return null;
  // A per-platform floor (a social source's) is a promise to that platform and stands.
  return scheduleFrom(times, now, floor === MIN_INTERVAL ? DATED_MIN_INTERVAL : floor);
}

/**
 * The interval a set of instants implies.
 *
 * The whole of the scheduling policy, extracted so that the two things which
 * can stand in for "when did this feed publish" run through identical
 * arithmetic rather than through two ladders that drift apart. Those two things
 * are the dates in the document (`intervalFromDates`) and, when a document
 * carries none, the times we ourselves watched its contents change
 * (`intervalFromChanges`).
 *
 * @param {number[]} times epoch ms, newest first, at least one
 * @param {number} now epoch ms
 * @returns {number} minutes, between MIN_INTERVAL and MAX_INTERVAL
 */
function scheduleFrom(times, now, floor = MIN_INTERVAL) {
  // The policy itself is the house one, shared with p0dcasters: between posts a
  // feed is read four times per rhythm but never sleeps past the point its next
  // post is due; inside that window it is read 24 times per rhythm (at most six
  // hours apart), so a weekly show is checked every few hours around release day
  // instead of every 3.5 days. A feed silent for three rhythms backs off on its
  // silence, capped at a week; silent 180 days and it is archived, read again in
  // 90 (MAX_INTERVAL). The floor stays this module's, per source.
  const plan = planNext(times, { now, floor, revisitEvery: MAX_INTERVAL });
  return plan ? plan.minutes : clamp(MIN_INTERVAL, floor, MAX_INTERVAL);
}

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.round(Math.min(Math.max(n, lo), hi));
}

/* ------------------------------------------------- feeds that state no dates */

/**
 * How many observed changes to keep on the feed row.
 *
 * Twelve, which is a rhythm out of eleven gaps and a few kilobytes across the
 * whole directory. More would buy a steadier median at the cost of describing a
 * publisher who has since changed how often they post, which is the same
 * trade-off `SAMPLE` makes and it lands in the same place.
 */
export const CHANGE_LOG_LIMIT = 12;

/**
 * The earliest instant this log can honestly hold.
 *
 * Every entry was written by this crawler's own clock, and this crawler did not
 * exist in 2019. Anything older is a corrupt row rather than a very patient
 * publisher.
 */
const EPOCH_FLOOR = Date.parse('2020-01-01T00:00:00.000Z');

/**
 * A fingerprint of what a feed currently contains.
 *
 * Over the *identity* of the items and not their bodies, because the question is
 * "did this publisher publish", and a corrected typo in a post from March is not
 * a publication. Sorted first, so a feed that reorders its entries — plenty of
 * generators emit them in whatever order the filesystem walked — is not read as
 * having republished all of them at once.
 *
 * A title is included alongside the guid and link because a retitled post is a
 * visible editorial act the directory does want to notice, and because some
 * feeds carry neither guid nor link and a title is all there is to key on.
 *
 * Truncated to 32 hex characters. This is compared for equality against a value
 * we wrote ourselves, never looked up and never defended against an adversary
 * choosing inputs, so the collision budget is enormous and the column stays
 * small.
 *
 * **An empty document gets a signature like any other, and this matters more
 * than it sounds.** Sampling production's undated feeds on 2026-08-19, most of
 * the ones pinned to the hourly floor had `item_count = 0` -- they parse, they
 * are simply empty, and they have been read every hour for months to be told so
 * again. Returning nothing for them would make every crawl compare unequal to
 * the last, which is exactly the "always changed, so always hourly" failure this
 * module exists to end. Listing nothing is a fact about a feed, it is a stable
 * one, and it deserves a stable fingerprint.
 *
 * A document whose items carry no guid, no link and no title hashes the same as
 * an empty one. That is a real limitation and an acceptable one: an item with
 * nothing to identify it cannot be stored, shown or de-duplicated either, so a
 * feed made entirely of them has published nothing anybody can act on.
 *
 * @param {Array<{ guid?: unknown, link?: unknown, title?: unknown }>} items
 * @returns {string} 32 hex characters, stable across reordering
 */
export function contentSignature(items) {
  const keys = [];
  for (const item of items ?? []) {
    const guid = item?.guid ?? '';
    const link = item?.link ?? '';
    const title = item?.title ?? '';
    const key = `${guid} ${link} ${title}`;
    // An item with nothing to identify it cannot contribute; counting it would
    // make N such items indistinguishable from one.
    if (key !== '  ') keys.push(key);
  }
  keys.sort();
  return createHash('sha256').update(keys.join(' ')).digest('hex').slice(0, 32);
}

/**
 * The change log stored on a feed row, cleaned and newest first.
 *
 * Tolerant of anything a text column can hold, because it is written by a
 * version of the crawler that may not be the one reading it: bad JSON, a
 * non-array, unparseable entries and future dates all degrade to "no history",
 * which costs a feed one crawl on the fallback ladder rather than an exception
 * on the hot path.
 *
 * @param {unknown} raw the `change_log` column
 * @param {number} [now] epoch ms
 * @returns {number[]} epoch ms, newest first
 */
export function changeTimes(raw, now = Date.now()) {
  if (raw === null || raw === undefined || raw === '') return [];
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out = [];
  for (const entry of parsed) {
    // A number is taken as epoch milliseconds, which is what a hand-written
    // backfill or another language's JSON encoder is most likely to have put
    // here. Everything else goes through Date.parse.
    const t = typeof entry === 'number' ? entry : Date.parse(String(entry));
    if (!Number.isFinite(t)) continue;
    // Our own clock wrote these, so a future one is a bad row rather than a fast
    // publisher — and unlike a publisher's date there is no skew to allow for.
    if (t > now) continue;
    // Nor can one predate the service. This is not pedantry: `Date.parse('123')`
    // is the year 123, so a bare number that slipped in as a string would read
    // as nineteen centuries of silence, and the feed would be filed at the
    // ninety-day ceiling on the strength of a typo.
    if (t < EPOCH_FLOOR) continue;
    out.push(t);
  }
  return out.sort((a, b) => b - a).slice(0, CHANGE_LOG_LIMIT);
}

/**
 * The change log to store after this crawl.
 *
 * Returns the existing entries untouched when nothing changed, so an unchanged
 * feed writes the same string back and the column stays a record of changes
 * rather than a record of crawls — which is the whole point of it, since crawls
 * are exactly what this is trying to stop doing.
 *
 * @param {unknown} raw the `change_log` column as it stands
 * @param {boolean} changed whether this crawl saw different contents
 * @param {number} [now] epoch ms
 * @returns {string} JSON, ready to store
 */
export function recordChange(raw, changed, now = Date.now()) {
  const times = changeTimes(raw, now);
  const next = changed ? [now, ...times].slice(0, CHANGE_LOG_LIMIT) : times;
  return JSON.stringify(next.map((t) => new Date(t).toISOString()));
}

/**
 * How long to wait before reading a feed whose document states no dates.
 *
 * The substitute for `intervalFromDates`, running the same rhythm-and-silence
 * arithmetic over instants we observed rather than instants a publisher claimed.
 * It exists because those feeds are, measured on production on 2026-08-19, two
 * percent of the directory and forty-four percent of the crawl demand: with no
 * dates there is nothing for cadence to reason about, so they fall to the old
 * doubling ladder, and the ladder returns to its floor whenever a crawl stores
 * anything. A feed whose guids churn stores something every time and therefore
 * never leaves the floor.
 *
 * **One observation is enough here, and that is the real difference from
 * `intervalFromDates`.** A single date in a document says when one post went out
 * and nothing about whether another will follow, so dates need two before they
 * mean anything. A single entry in this log means "the contents changed then,
 * and we have looked every time since and seen nothing" — because the looking is
 * ours. Silence measured from it is therefore evidence, and a feed that never
 * changes decays towards the ceiling on its own: each crawl finds the silence a
 * little longer, sets the interval to a quarter of it, and the gap grows by
 * about a quarter each time until it reaches ninety days. No "is this feed dead"
 * classifier, and nothing to maintain.
 *
 * @param {unknown} raw the `change_log` column
 * @param {number} [now] epoch ms
 * @returns {number|null} minutes, or null when the log holds nothing usable and
 *   the caller should fall back to the ladder
 */
export function intervalFromChanges(raw, now = Date.now(), floor = MIN_INTERVAL) {
  const times = changeTimes(raw, now);
  if (times.length === 0) return null;
  return scheduleFrom(times, now, floor);
}

/**
 * The interval to store, given one just computed and the one the feed already
 * had.
 *
 * Used on the paths where a crawl learned that **nothing had changed** — a 304,
 * or a document whose signature matched what was already on file. Such a crawl
 * is evidence in one direction only, so the interval may lengthen and must never
 * shorten: a feed sitting at ninety days because it has published nothing since
 * 2023 should not be pulled back to a fortnight merely because we checked and it
 * was still silent. Without this the interval of a slow feed oscillates instead
 * of settling.
 *
 * @param {number|null} computed
 * @param {unknown} current the feed's `fetch_interval_minutes`
 * @returns {number|null} null when there was nothing to compute either
 */
export function neverSooner(computed, current, floor = MIN_INTERVAL) {
  if (computed === null || computed === undefined) return null;
  const held = Number(current);
  if (!Number.isFinite(held) || held <= 0) return clamp(computed, floor, MAX_INTERVAL);
  return clamp(Math.max(computed, held), floor, MAX_INTERVAL);
}
