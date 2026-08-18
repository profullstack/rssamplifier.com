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
 * How far past its own rhythm a feed must fall before it counts as having gone
 * quiet, rather than merely being between posts.
 *
 * Three, because a weekly blog that misses a week is still a weekly blog, and
 * one that has missed three has changed. Below this multiple the feed is
 * scheduled on its rhythm; above it, on its silence.
 */
const QUIET_MULTIPLE = 3;

/**
 * The gap between consecutive posts, in minutes, as a sorted list.
 *
 * @param {number[]} times epoch ms, any order
 * @returns {number[]} ascending gaps in minutes
 */
function gaps(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (sorted[i] - sorted[i - 1]) / 60_000;
    // Two posts published in the same instant are one editorial act, not a
    // rhythm of zero. Dropping them keeps a site that publishes its whole
    // morning batch at 06:00 from being read as posting continuously.
    if (gap > 0) out.push(gap);
  }
  return out.sort((a, b) => a - b);
}

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
export function intervalFromDates(items, now = Date.now()) {
  const times = publishedTimes(items, now);
  if (times.length < 2) return null;

  const silence = Math.max(0, (now - times[0]) / 60_000);

  // The typical gap, not the mean. A blog that posted forty times during one
  // conference and monthly otherwise has a mean that describes neither; the
  // median describes the ordinary week, which is what we are scheduling for.
  const spacing = gaps(times);

  // Every date in the document is the same instant. That is a feed with one
  // publishing event, not a feed with a rhythm of zero — an archive dumped in
  // one go, or a generator that stamps every entry with the build time. There
  // is no cadence to infer, so schedule it on its silence alone, which is the
  // only real evidence available.
  if (spacing.length === 0) return clamp(silence / 4, MIN_INTERVAL, MAX_INTERVAL);

  const rhythm = median(spacing);

  // Still keeping to its own rhythm: read it at that rhythm. Halved, so a post
  // is found in the first half of its cycle rather than, on average, halfway
  // through the next one — the directory's freshness promise is about how long
  // a post can sit unseen, and this is the term that bounds it.
  if (silence <= rhythm * QUIET_MULTIPLE) {
    return clamp(rhythm / 2, MIN_INTERVAL, MAX_INTERVAL);
  }

  // Gone quiet relative to its own history. Schedule on the silence instead,
  // which makes the back-off self-scaling: the longer a feed stays dead the
  // less often it is asked, without a table of thresholds to maintain and
  // without ever quite giving up on it.
  return clamp(silence / 4, MIN_INTERVAL, MAX_INTERVAL);
}

/**
 * @param {number[]} sorted ascending
 * @returns {number}
 */
function median(sorted) {
  if (sorted.length === 0) return MIN_INTERVAL;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
