/**
 * Is this feed a finished work rather than a going concern?
 *
 * Worthiness asks "is somebody still writing here", and for a blog that is the
 * right question. For a lecture series it is the wrong one twice over. A course
 * recorded in 2021 has published nothing since and never will — that is what
 * finishing a course means — so `assessFeed` rejects it as `abandoned`, and the
 * nineteen lectures a reader would actually want to watch never reach the
 * directory. Both of the real playlists this was written against, a Santa Cruz
 * distributed-systems course and a Yale philosophy course, scored zero for
 * exactly that reason.
 *
 * So a series is judged on coherence instead of recency: does it hold enough
 * episodes, do they lead somewhere, and are they by one person. Nothing here
 * looks at a date at all.
 *
 * Kept apart from worthiness.js rather than folded in as a special case,
 * because the two answer contradictory questions and a rule set that tried to
 * hold both would have to disable half of itself depending on the input.
 */

/**
 * @typedef {object} SeriesRules
 * @property {number} minItems    fewest entries before a playlist is a series rather than a handful of links
 * @property {number} maxAuthors  most distinct bylines before it reads as a mixtape
 * @property {number} minScore    score needed to pass, out of 100
 */

/** @type {SeriesRules} */
export const DEFAULT_SERIES_RULES = {
  // Four, not the two worthiness allows. A playlist is cheap to make and the
  // web is full of three-video ones; a series that is worth a page in a
  // directory is a body of work.
  minItems: 4,
  // Three, so a co-taught course or a conference with a couple of hosts still
  // counts, while a "stuff I liked this year" list does not.
  maxAuthors: 3,
  minScore: 50,
};

/** A YouTube playlist feed, which is the only series feed that exists today. */
const PLAYLIST_FEED = /[?&]playlist_id=/i;

/**
 * Is this URL a feed of a finished, ordered work?
 *
 * Read off the URL rather than the parsed document because the URL is what
 * discovery queues and what the directory stores, so the same string decides
 * this at every stage. A channel feed and a playlist feed parse identically —
 * both are YouTube Atom full of `yt:videoId` — and only the query parameter
 * tells them apart.
 *
 * @param {string} feedUrl
 * @returns {boolean}
 */
export function isSeriesFeed(feedUrl) {
  return PLAYLIST_FEED.test(String(feedUrl ?? ''));
}

/**
 * Who is credited across a feed's entries.
 *
 * The signal that separates a course from a bookmark folder, and it is free:
 * the bylines are already in the document that had to be fetched anyway. One
 * name across nineteen entries is somebody teaching a course. Nine names across
 * twelve entries is somebody saving videos they enjoyed — worth watching,
 * perhaps, but not a work, and not something to give a page of its own to.
 *
 * A single *foreign* byline is the interesting middle case and is deliberately
 * treated as coherent: a channel that collects one university's lectures into a
 * playlist has curated a real course, and the playlist is the only place that
 * course exists as an ordered thing.
 *
 * @param {Array<{ author?: string }>} items
 * @returns {string[]} distinct bylines, in first-seen order
 */
export function seriesAuthors(items) {
  const seen = new Set();
  const authors = [];

  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item?.author ?? '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    authors.push(name);
  }

  return authors;
}

/**
 * Judge a series.
 *
 * Mirrors `assessFeed`'s shape — same verdict object, same every-reason-listed
 * habit — so the promotion path can swap one for the other without caring which
 * ran. The scores are not comparable between the two and are not meant to be:
 * they answer different questions and only ever grade their own kind of feed.
 *
 * @param {{ feedUrl: string, feed: { title?: string, description?: string, items?: Array<object> }, rules?: Partial<SeriesRules> }} input
 * @returns {{ worthy: boolean, score: number, reasons: string[], authors: string[] }}
 */
export function assessSeries({ feedUrl, feed, rules = {} }) {
  const r = { ...DEFAULT_SERIES_RULES, ...rules };
  const reasons = [];
  const items = Array.isArray(feed?.items) ? feed.items : [];
  const authors = seriesAuthors(items);

  // ---- disqualifying ----------------------------------------------------
  if (items.length < r.minItems) {
    return { worthy: false, score: 0, reasons: ['too-short'], authors };
  }

  // Entries that link nowhere cannot be watched, and a watch queue full of
  // unplayable rows is worse than an empty one.
  const linked = items.filter((i) => String(i?.url ?? '').trim()).length;
  if (linked === 0) {
    return { worthy: false, score: 0, reasons: ['unlinked-items'], authors };
  }

  if (authors.length > r.maxAuthors) {
    return { worthy: false, score: 0, reasons: ['mixtape'], authors };
  }

  // ---- scored signals ---------------------------------------------------
  let score = 0;

  // Length, which for a series is the closest thing to evidence of intent. A
  // twenty-part course and a five-part one are both series; the first is more
  // obviously one.
  if (items.length >= 12) score += 35;
  else if (items.length >= 8) score += 28;
  else score += 20;

  // Coherence. One byline is the strong case and is scored as such; two or
  // three is a co-taught course and still passes, with less to spare.
  if (authors.length === 1) score += 35;
  else if (authors.length > 1) score += 15;
  else {
    // No bylines anywhere. Not a rejection on its own — plenty of valid Atom
    // omits the author — but worth little, and deliberately worth little enough
    // that a series with no byline *and* no title cannot reach the threshold.
    // Either one missing is survivable; both missing means the directory would
    // be publishing a page that says nothing about what it holds.
    reasons.push('unattributed');
    score += 5;
  }

  const title = String(feed?.title ?? '').trim();
  if (!title || title === '(untitled)') reasons.push('untitled');
  else score += 20;

  if (String(feed?.description ?? '').trim()) score += 5;

  if (linked < items.length) reasons.push('some-unlinked-items');
  else score += 5;

  score = Math.max(0, Math.min(100, score));
  const worthy = score >= r.minScore;
  if (!worthy && reasons.length === 0) reasons.push('low-score');

  return { worthy, score, reasons, authors };
}
