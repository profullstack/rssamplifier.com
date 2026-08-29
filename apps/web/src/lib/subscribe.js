/*
 * The feeds a page offers, in one place.
 *
 * Every listing on the site now publishes its own document (see lib/river.js),
 * and a feed nobody can find is a feed nobody uses. Two things have to agree
 * for it to be findable: the `<link rel="alternate">` tags every feed reader
 * and browser extension looks for, and the visible row of links a person
 * clicks. Both are built from the list below, so a page cannot advertise one
 * set in its head and link a different one in its body.
 *
 * `.xml` is absent on purpose — it is the same document as `.rss` under a
 * second name, and offering both invites the question of how they differ. So
 * are `.m3u` and `.pls`: they exist for the surfaces that have audio, are
 * linked where that is true, and autodiscovering one as though it were a
 * subscription would hand a feed reader a file it cannot poll.
 */

/**
 * What a page offers, in the order it offers them.
 *
 * RSS first because it is what "subscribe" means to almost everybody; Markdown
 * last because its audience is not subscribing at all — it is reading, or
 * feeding the document to something that reads.
 */
export const SUBSCRIBE_FORMATS = ['rss', 'atom', 'json', 'md'];

/** The MIME type each one is announced as, without the charset. */
const TYPES = {
  rss: 'application/rss+xml',
  atom: 'application/atom+xml',
  json: 'application/feed+json',
  md: 'text/markdown',
};

/** What each extension is, spelled out. */
const NAMES = {
  rss: 'RSS 2.0',
  atom: 'Atom 1.0',
  json: 'JSON Feed 1.1',
  md: 'Markdown',
  xml: 'RSS 2.0',
  m3u: 'M3U playlist',
  pls: 'PLS playlist',
};

/**
 * The `title` a format's link carries.
 *
 * @param {string} ext
 * @param {string} what the noun for what this listing holds
 * @returns {string}
 */
export function formatTitle(ext, what) {
  const name = NAMES[ext] ?? ext.toUpperCase();

  if (ext === 'm3u' || ext === 'pls') return `${name} — the playable media from ${what}`;
  if (ext === 'md') return `${name} — recent posts from ${what}, as a document to read`;
  return `${name} — recent posts from ${what}`;
}

/**
 * The `alternates.types` block for a page's metadata.
 *
 * @param {string} base the page's path or URL, without an extension
 * @param {string} title what a reader should call the feed
 * @param {string} [query] a query string to keep — `?q=lisp` — for the pages
 *   whose identity is in the query rather than the path
 * @returns {Record<string, Array<{ url: string, title: string }>>}
 */
export function feedAlternates(base, title, query = '') {
  /** @type {Record<string, Array<{ url: string, title: string }>>} */
  const types = {};

  for (const ext of SUBSCRIBE_FORMATS) {
    types[TYPES[ext]] = [{ url: `${base}.${ext}${query}`, title: `${title} — ${NAMES[ext]}` }];
  }

  return types;
}
