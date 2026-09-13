/**
 * OPML. Reading it is shared with every other directory through
 * @profullstack/submit-feed (the lenient walk that recurses into folders and
 * returns an empty list for a malformed upload rather than throwing); writing
 * it stays here, because the export uses this site's column names and is
 * streamed in three parts for a document of hundreds of thousands of rows.
 */

export { parseOpml } from '@profullstack/submit-feed/core';

/**
 * Render a directory listing as an OPML subscription list.
 *
 * This is the bulk-export half of the contract: anything the directory holds
 * can be pulled back out and loaded straight into a feed reader or an agent.
 *
 * @param {Array<{ title: string, feed_url: string, site_url?: string|null }>} feeds
 * @param {string} [title]
 * @returns {string} OPML 2.0 document
 */
export function buildOpml(feeds, title = 'RSS Amplifier') {
  const rows = feeds.map((f) => opmlOutline(f)).join('\n');
  return `${opmlHead(title)}${rows}\n${opmlFoot()}`;
}

/**
 * Everything in an OPML document before the first outline.
 *
 * Split out so the full directory export can be streamed: it is tens of
 * thousands of entries, and rendering it into one string would hold both the
 * rows and the finished document in memory at once.
 *
 * @param {string} [title]
 * @returns {string}
 */
export function opmlHead(title = 'RSS Amplifier') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${esc(title)}</title>
  </head>
  <body>
`;
}

/**
 * A single `<outline>` element, without its trailing newline.
 *
 * @param {{ title: string, feed_url: string, site_url?: string|null }} feed
 * @returns {string}
 */
export function opmlOutline(feed) {
  const attrs = [
    `text="${esc(feed.title)}"`,
    `title="${esc(feed.title)}"`,
    'type="rss"',
    `xmlUrl="${esc(feed.feed_url)}"`,
  ];
  if (feed.site_url) attrs.push(`htmlUrl="${esc(feed.site_url)}"`);
  return `    <outline ${attrs.join(' ')} />`;
}

/**
 * Everything in an OPML document after the last outline.
 *
 * @returns {string}
 */
export function opmlFoot() {
  return `  </body>
</opml>
`;
}

/**
 * Escape a value for use inside an XML attribute.
 *
 * @param {unknown} v
 * @returns {string}
 */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
