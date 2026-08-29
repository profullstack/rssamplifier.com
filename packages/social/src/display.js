/**
 * What to call a social source on a page, when its own title is no use.
 *
 * The 50,026 subreddits were bulk-imported from OPML, and the crawler has read
 * a few hundred of them. Until it reaches one, the row's `title` is whatever
 * the OPML said — and for that catalogue it is very often the bare host, so
 * `/r/programming` renders a heading that says **"reddit.com"**.
 *
 * The fix is not to rewrite the stored titles. A title is the publisher's, and
 * the crawler replaces it with the real one soon enough; overwriting the column
 * would fight `markCrawlSuccess` on every subsequent crawl. This is a render
 * decision instead: when the stored title carries no information, show the
 * canonical name — `r/programming`, `@nasa on Instagram` — which we always know
 * because the ref encodes it.
 *
 * Deliberately conservative. A real title always wins, including one that
 * merely *contains* the platform's name, because "Reddit Blog" is a genuine
 * feed title and not a placeholder.
 */

/**
 * Titles that say nothing about the source they are attached to.
 *
 * Matched whole, case-insensitively, after trimming. Anything longer or more
 * specific is somebody's actual title and is left alone.
 */
const EMPTY_TITLES = new Set([
  'reddit',
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'instagram',
  'instagram.com',
  'www.instagram.com',
  'facebook',
  'facebook.com',
  'www.facebook.com',
  'x',
  'x.com',
  'twitter',
  'twitter.com',
  '(untitled)',
  'untitled',
  'rss',
  'feed',
  'rss feed',
]);

/**
 * The name to render for a social row.
 *
 * @param {{ title?: unknown, feed_url?: unknown }} feed the stored row
 * @param {string} label the canonical name, from the ref
 * @returns {string}
 */
export function socialDisplayTitle(feed, label) {
  const stored = String(feed?.title ?? '').trim();

  if (!stored) return label;
  if (EMPTY_TITLES.has(stored.toLowerCase())) return label;

  // A title that is just the URL it was imported from is the same non-answer in
  // a different shape, and the OPML catalogue is full of them.
  const url = String(feed?.feed_url ?? '').trim();
  if (url && (stored === url || url.includes(stored))) return label;

  return stored;
}
