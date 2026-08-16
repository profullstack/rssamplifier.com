import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
});

/**
 * Walk an OPML outline tree and collect every node that carries a feed URL.
 *
 * OPML nests arbitrarily — subscription lists are usually grouped into folders,
 * and folders can contain folders — so this recurses rather than reading only
 * the top level. Nodes without an xmlUrl are folders, not feeds.
 *
 * @param {unknown} node
 * @param {Array<{ url: string, title: string }>} out
 */
function walk(node, out) {
  if (!node) return;
  const list = Array.isArray(node) ? node : [node];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    const url = item['@xmlUrl'] || item['@xmlurl'];
    if (typeof url === 'string' && url.trim()) {
      const siteUrl = item['@htmlUrl'] || item['@htmlurl'];
      out.push({
        url: url.trim(),
        title: (item['@title'] || item['@text'] || '').toString().trim(),
        // Carried through for bulk imports, which trust the catalogue instead
        // of fetching every feed to discover its site.
        siteUrl: typeof siteUrl === 'string' && siteUrl.trim() ? siteUrl.trim() : null,
      });
    }

    if (item.outline) walk(item.outline, out);
  }
}

/**
 * Extract feed URLs from an OPML document.
 *
 * Deliberately lenient: a malformed OPML returns an empty list rather than
 * throwing, because this runs on user-submitted uploads and one bad file must
 * not take down the submit endpoint.
 *
 * @param {string} xml raw OPML
 * @returns {Array<{ url: string, title: string, siteUrl: string|null }>} deduped by URL, order preserved
 */
export function parseOpml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return [];

  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }

  const found = [];
  walk(doc?.opml?.body?.outline, found);

  const seen = new Set();
  return found.filter((f) => {
    const key = f.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
  const rows = feeds
    .map((f) => {
      const attrs = [
        `text="${esc(f.title)}"`,
        `title="${esc(f.title)}"`,
        'type="rss"',
        `xmlUrl="${esc(f.feed_url)}"`,
      ];
      if (f.site_url) attrs.push(`htmlUrl="${esc(f.site_url)}"`);
      return `    <outline ${attrs.join(' ')} />`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${esc(title)}</title>
  </head>
  <body>
${rows}
  </body>
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
