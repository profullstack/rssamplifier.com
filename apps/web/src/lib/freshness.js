/**
 * How current the directory's copy of a feed is, and whether the feed is alive.
 *
 * These are two different questions and a directory at this scale has to answer
 * both, separately, in public. An agent reading a post out of here is trusting
 * two things it cannot check for itself: that we read the publisher recently,
 * and that the publisher is still publishing. Getting either wrong is a silent
 * failure — the answer still looks like an answer — and silent failures are
 * what destroy trust in a directory rather than visible ones.
 *
 * They also fail in opposite directions:
 *
 *   * a **stale read** is our fault. The feed may have posted this morning and
 *     we have not looked since Tuesday, so what we are serving is behind.
 *   * a **dormant feed** is nobody's fault. We read it eleven minutes ago and
 *     it is perfectly current; there has simply been nothing since 2024.
 *
 * A single "last updated" line conflates the two, and conflating them is how a
 * reader concludes the directory is broken when a blog has merely retired — or,
 * far worse, concludes a blog has retired when the directory has stopped
 * looking. Sampling production, 15.8% of active feeds had not published in over
 * two years, so the dormant case is not an edge case here: it is a sixth of the
 * directory, and it needs to be labelled rather than hidden.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long a successful read stays "current" before it is worth flagging.
 *
 * Deliberately generous, and deliberately *not* a fixed number of hours: a feed
 * is scheduled on its own rhythm now (see packages/ingest/src/cadence.js), so a
 * monthly blog read a week ago is exactly as current as a news site read an
 * hour ago. Judging both against one clock would paint most of the directory
 * amber for behaving precisely as intended.
 *
 * Twice the interval the crawler itself chose, so this only fires when the
 * crawler has genuinely fallen behind its own plan — which is the condition
 * worth showing a reader.
 */
const OVERDUE_MULTIPLE = 2;

/** Below this, a feed that has not published is called dormant rather than quiet. */
const DORMANT_DAYS = 365;

/**
 * A short, plain interval. "3 minutes", "4 hours", "2 days", "8 months".
 *
 * Words rather than the compact `4h`/`2d` of the status board: this one is read
 * inside a sentence by people who did not come here to read a dashboard.
 *
 * @param {number} ms
 * @returns {string}
 */
export function humanGap(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < MINUTE) return 'moments';
  if (n < HOUR) return plural(Math.round(n / MINUTE), 'minute');
  if (n < DAY) return plural(Math.round(n / HOUR), 'hour');
  if (n < 60 * DAY) return plural(Math.round(n / DAY), 'day');
  if (n < 730 * DAY) return plural(Math.round(n / (30 * DAY)), 'month');
  return plural(Math.round(n / (365 * DAY)), 'year');
}

/**
 * @param {number} n
 * @param {string} unit
 * @returns {string}
 */
function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Parse a stored timestamp, or null.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function at(value) {
  if (value === null || value === undefined || value === '') return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * What to say about a feed's freshness.
 *
 * Every field is derived rather than stored, so this cannot drift out of step
 * with the crawler the way a cached "status" column would.
 *
 * @param {object} feed a feeds row
 * @param {unknown} [newestPost] the newest post's published_at, if the caller
 *   has it in hand. The feed page does; the API resolves it separately.
 * @param {number} [now] epoch ms
 * @returns {{
 *   checkedAt: string|null, checkedGap: string|null,
 *   publishedAt: string|null, publishedGap: string|null,
 *   nextCheckAt: string|null,
 *   state: 'live'|'dormant'|'overdue'|'failing'|'unread',
 *   note: string,
 * }}
 */
export function freshness(feed = {}, newestPost = null, now = Date.now()) {
  const checked = at(feed.last_success_at);
  const published = at(newestPost);
  const next = at(feed.next_fetch_at);
  const interval = Math.max(1, Number(feed.fetch_interval_minutes) || 60) * MINUTE;

  const base = {
    checkedAt: checked === null ? null : new Date(checked).toISOString(),
    checkedGap: checked === null ? null : humanGap(now - checked),
    publishedAt: published === null ? null : new Date(published).toISOString(),
    publishedGap: published === null ? null : humanGap(now - published),
    nextCheckAt: next === null ? null : new Date(next).toISOString(),
  };

  // Never successfully read. Distinct from every other state: we are not
  // serving stale data, we are serving no data, and saying "last checked
  // never" is more honest than omitting the line.
  if (checked === null) {
    return {
      ...base,
      state: 'unread',
      note: 'Not yet read. This feed is in the queue and has not been fetched successfully.',
    };
  }

  const sinceChecked = now - checked;

  // Erroring takes precedence over everything below it. A feed that has been
  // failing for a week may still look recently-read if the failures started
  // after a success, and that is the reading that misleads.
  if (feed.status === 'error' || (feed.last_error && Number(feed.error_count) > 0)) {
    return {
      ...base,
      state: 'failing',
      note: `Last read successfully ${humanGap(sinceChecked)} ago; attempts since then have failed.`,
    };
  }

  // We have fallen behind our own schedule for this feed.
  if (sinceChecked > interval * OVERDUE_MULTIPLE) {
    return {
      ...base,
      state: 'overdue',
      note: `Last read ${humanGap(sinceChecked)} ago, longer than this feed's ${humanGap(interval)} schedule.`,
    };
  }

  // Read on time, but the publisher has gone quiet. This is the one the reader
  // most needs and is least likely to guess: the data is current, and current
  // means "nothing since 2023".
  if (published !== null && now - published > DORMANT_DAYS * DAY) {
    return {
      ...base,
      state: 'dormant',
      note: `Read ${humanGap(sinceChecked)} ago and current, but nothing has been published for ${humanGap(now - published)}.`,
    };
  }

  return {
    ...base,
    state: 'live',
    note: published === null
      ? `Read ${humanGap(sinceChecked)} ago.`
      : `Read ${humanGap(sinceChecked)} ago; last published ${humanGap(now - published)} ago.`,
  };
}

/** The word shown on the badge for each state. */
export const FRESHNESS_LABEL = {
  live: 'Live',
  dormant: 'Dormant',
  overdue: 'Overdue',
  failing: 'Failing',
  unread: 'Not yet read',
};
