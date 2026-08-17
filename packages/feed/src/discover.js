/**
 * Feed discovery: people submit "myblog.com", not "myblog.com/feed.xml".
 * Turning the former into the latter is most of what makes submission painless.
 */

import { looksLikePlaylist } from './playlist.js';

const COMMON_PATHS = [
  '/feed',
  '/feed.xml',
  '/rss',
  '/rss.xml',
  '/atom.xml',
  '/index.xml',
  '/feed/',
  '/feeds/posts/default',
  '/?feed=rss2',
  '/feed.json',
];

/** Content types that indicate the body is a feed rather than a web page. */
const FEED_TYPES = [
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/xml',
  'text/xml',
  'application/json',
];

/**
 * Normalize user input into an absolute http(s) URL.
 *
 * Accepts "example.com", "//example.com" and "http://example.com", because all
 * three get pasted into submission boxes. Returns null for anything that is not
 * a usable web URL — including non-http schemes, which must never be fetched.
 *
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;

  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (!/^https?:\/\//i.test(raw)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // mailto:, javascript:, file:
    raw = `https://${raw}`;
  }

  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Extract feed URLs advertised by a page's <link rel="alternate"> tags.
 *
 * This is the correct, standards-based path — the guessed paths below are only
 * a fallback for sites that don't advertise.
 *
 * @param {string} html
 * @param {string} baseUrl for resolving relative hrefs
 * @returns {string[]} absolute feed URLs, in document order, deduped
 */
export function findFeedLinks(html, baseUrl) {
  if (typeof html !== 'string') return [];
  const out = [];

  // Match <link> tags, then pull attributes out individually: attribute order
  // varies between generators and a single positional regex misses most of them.
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];

  for (const tag of tags) {
    const rel = /\brel\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (rel !== 'alternate') continue;

    const type = /\btype\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (!type || !FEED_TYPES.includes(type)) continue;

    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;

    try {
      const abs = new URL(href, baseUrl).toString();
      if (!out.includes(abs)) out.push(abs);
    } catch {
      // skip unresolvable href
    }
  }

  return out;
}

/**
 * Candidate feed URLs to try for a site, in priority order.
 *
 * @param {string} siteUrl
 * @returns {string[]}
 */
export function guessFeedUrls(siteUrl) {
  const out = [];
  for (const p of COMMON_PATHS) {
    try {
      out.push(new URL(p, siteUrl).toString());
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Decide whether a fetched response looks like a feed.
 *
 * Content-type alone is unreliable — plenty of feeds are served as text/plain
 * or text/html — so the body is sniffed too.
 *
 * @param {string} contentType
 * @param {string} body
 * @param {string} [url] the URL it came from, which is the only thing that
 *   identifies the plain form of an m3u
 * @returns {boolean}
 */
export function looksLikeFeed(contentType, body, url = '') {
  // A playlist is a feed here — a list of media with titles — so it is admitted
  // on the same footing rather than sniffed for afterwards.
  if (looksLikePlaylist(contentType, body, url)) return true;

  const ct = (contentType || '').toLowerCase();
  if (FEED_TYPES.some((t) => ct.includes(t))) {
    // application/json is only a feed if it's actually JSON Feed.
    if (ct.includes('json') && !ct.includes('feed+json')) {
      return /"(?:items|version)"\s*:/.test(body ?? '');
    }
    return true;
  }

  const head = (body ?? '').slice(0, 2000).toLowerCase();
  if (/<rss\b/.test(head)) return true;
  if (/<feed\b[^>]*xmlns/.test(head)) return true;
  if (/<rdf:rdf\b/.test(head)) return true;
  if (/"version"\s*:\s*"https:\/\/jsonfeed\.org/.test(head)) return true;

  return false;
}
