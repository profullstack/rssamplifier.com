/**
 * Is this feed worth a page in the directory?
 *
 * Submission is a human vouching for a blog, so it gets the benefit of the
 * doubt. Keyword discovery has no human in it at all: a search for "siberian
 * huskies" returns pet shops, content farms, and the comment feeds of long-dead
 * forums, and every one of them resolves to valid RSS. Something has to say no.
 *
 * The rules are deliberately shallow and cheap — they run on a feed that has
 * already been fetched and parsed, and they never fetch anything themselves.
 * They are tuned to reject the obvious rather than to judge writing.
 */

/**
 * @typedef {object} WorthinessRules
 * @property {number} minItems      fewest entries a real blog carries
 * @property {number} maxAgeDays    how long since the newest entry before it reads as abandoned
 * @property {number} minScore      score needed to pass, out of 100
 */

/** @type {WorthinessRules} */
export const DEFAULT_RULES = {
  minItems: 2,
  // Eighteen months. Small blogs go quiet for a year and come back, and a
  // directory that drops them is a directory of corporate content calendars.
  maxAgeDays: 548,
  minScore: 50,
};

/** Feed URLs that are a discussion thread rather than a publication. */
const COMMENT_FEED = /\/comments\/?(?:feed)?\/?$|[?&]feed=comments|\/comments\.rss$/i;

/**
 * Paths that mark a feed as a slice of a site rather than the site itself.
 *
 * Tag and category feeds are usually duplicates of a main feed that a later
 * keyword run would find anyway, and indexing both puts the same blog in the
 * directory twice under two slugs.
 */
const PARTIAL_FEED = /\/(?:tag|tags|category|categories|label|search|author)\//i;

const DAY_MS = 86_400_000;

/**
 * Milliseconds since the newest dated entry, or null when nothing is dated.
 *
 * @param {Array<{ publishedAt?: string }>} items
 * @param {number} now
 * @returns {number|null}
 */
function ageOfNewest(items, now) {
  let newest = null;

  for (const item of items) {
    if (!item?.publishedAt) continue;
    const t = Date.parse(item.publishedAt);
    if (Number.isNaN(t)) continue;
    if (newest === null || t > newest) newest = t;
  }

  return newest === null ? null : now - newest;
}

/**
 * Judge a parsed feed.
 *
 * Returns every reason, not just the first: the status page shows the submitter
 * why a site was turned down, and "too-few-items" alone is a worse answer than
 * "too-few-items, undated, duplicate-titles".
 *
 * @param {{ feedUrl: string, feed: { title?: string, description?: string, items?: Array<object> }, now?: number, rules?: Partial<WorthinessRules> }} input
 * @returns {{ worthy: boolean, score: number, reasons: string[] }}
 */
export function assessFeed({ feedUrl, feed, now = Date.now(), rules = {} }) {
  const r = { ...DEFAULT_RULES, ...rules };
  const reasons = [];
  const items = Array.isArray(feed?.items) ? feed.items : [];

  // ---- disqualifying, whatever else is true -----------------------------
  // These are not "low quality", they are "not a blog". No score can rescue
  // them, so they short-circuit before the points are counted.
  if (COMMENT_FEED.test(feedUrl ?? '')) {
    return { worthy: false, score: 0, reasons: ['comments-feed'] };
  }
  if (PARTIAL_FEED.test(feedUrl ?? '')) {
    return { worthy: false, score: 0, reasons: ['partial-feed'] };
  }
  if (items.length < r.minItems) {
    return { worthy: false, score: 0, reasons: ['too-few-items'] };
  }

  const age = ageOfNewest(items, now);
  if (age !== null && age > r.maxAgeDays * DAY_MS) {
    return { worthy: false, score: 0, reasons: ['abandoned'] };
  }

  // A feed whose entries all share one title is a status page, a price ticker
  // or a spam mill — never a blog. Disqualifying rather than merely penalised:
  // such a feed is otherwise a model citizen (plenty of entries, posted today,
  // properly linked) and would sail past any score.
  const titles = new Set(items.map((i) => String(i?.title ?? '').trim().toLowerCase()));
  if (titles.size === 1 && items.length > 2) {
    return { worthy: false, score: 0, reasons: ['duplicate-titles'] };
  }

  // ---- scored signals ---------------------------------------------------
  let score = 0;

  // Enough entries to be a going concern rather than a stub.
  if (items.length >= 10) score += 30;
  else if (items.length >= 5) score += 20;
  else score += 10;

  // Recency, where it is known. An undated feed is common enough in the wild
  // that it costs points rather than a rejection.
  if (age === null) {
    reasons.push('undated');
    score += 10;
  } else if (age <= 90 * DAY_MS) score += 40;
  else if (age <= 365 * DAY_MS) score += 25;
  else score += 15;

  const title = String(feed?.title ?? '').trim();
  if (!title || title === '(untitled)') reasons.push('untitled');
  else score += 15;

  if (String(feed?.description ?? '').trim()) score += 10;

  // Entries that link nowhere cannot be read, which makes the feed useless to a
  // directory whose whole job is sending people to the blog.
  const linked = items.filter((i) => String(i?.url ?? '').trim()).length;
  if (linked === 0) {
    reasons.push('unlinked-items');
    score -= 20;
  } else score += 5;

  score = Math.max(0, Math.min(100, score));
  const worthy = score >= r.minScore;
  if (!worthy && reasons.length === 0) reasons.push('low-score');

  return { worthy, score, reasons };
}
