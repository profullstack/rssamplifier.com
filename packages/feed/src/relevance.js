/**
 * Does this feed have anything to do with the keyword that found it?
 *
 * Search engines answer commercial intent. "siberian huskies" returns the
 * kennel club, a pet insurer and a veterinary clinic before it returns anyone
 * writing about their dog — and a vet clinic's news feed is a perfectly valid,
 * perfectly active feed that sails through every structural check. Worthiness
 * asks "is this a blog"; this asks the other half, "is it a blog about the
 * thing that was searched for".
 *
 * Kept separate from worthiness because it is the only check that needs to know
 * the keyword, and because a feed submitted by a human has no keyword to be
 * relevant to.
 */

/** Words too common to carry a topic. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'best',
  'blog',
  'blogs',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'top',
  'with',
]);

/** How much feed text to search. Enough to be fair, bounded so it stays cheap. */
const MAX_ITEMS = 30;

/**
 * Reduce a word to a crude stem, so "huskies" matches "husky".
 *
 * A real stemmer is not worth a dependency here: the only job is to stop plural
 * and possessive forms from being treated as different topics, and cutting the
 * suffix off leaves a prefix that substring-matches every variant.
 *
 * @param {string} word
 * @returns {string}
 */
export function stem(word) {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/**
 * The meaningful stems of a keyword.
 *
 * @param {string} keyword
 * @returns {string[]}
 */
export function keywordStems(keyword) {
  const words = String(keyword ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  return [...new Set(words.map(stem))];
}

/**
 * The text of a feed, flattened for matching.
 *
 * @param {{ title?: string, description?: string, items?: Array<object> }} feed
 * @returns {string}
 */
export function feedText(feed) {
  const parts = [feed?.title ?? '', feed?.description ?? ''];

  for (const item of (feed?.items ?? []).slice(0, MAX_ITEMS)) {
    parts.push(item?.title ?? '', item?.summary ?? '');
  }

  return parts.join(' ').toLowerCase();
}

/**
 * Is the feed about the keyword?
 *
 * Half the keyword's stems must appear, rounded up — so a one-word keyword must
 * appear and "siberian huskies" is satisfied by a blog that only ever says
 * "husky". Requiring all of them would reject a husky blog for never using the
 * word "siberian", which is the common case.
 *
 * @param {{ keyword: string, feed: object }} input
 * @returns {{ relevant: boolean, matched: string[], required: number }}
 */
export function assessRelevance({ keyword, feed }) {
  const stems = keywordStems(keyword);

  // No usable keyword — nothing to be irrelevant to, so this check abstains
  // rather than rejecting everything.
  if (stems.length === 0) return { relevant: true, matched: [], required: 0 };

  const haystack = feedText(feed);
  const matched = stems.filter((s) => haystack.includes(s));
  const required = Math.ceil(stems.length / 2);

  return { relevant: matched.length >= required, matched, required };
}
