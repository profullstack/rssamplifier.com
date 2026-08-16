/**
 * Turning a page of search results into a list of sites worth checking.
 *
 * Search results are pages; the directory wants sites. Ten results from one
 * blog are one candidate, and most of what a keyword search returns is not a
 * blog at all.
 */

/** Keywords accepted in a single run. */
export const MAX_KEYWORDS = 100;

/**
 * Hosts that will never be a directory entry.
 *
 * Not a quality judgement: these are platforms whose per-user feeds are real
 * but whose apex is not a blog, plus the retail and reference sites that pad
 * out every commercial search. Blogging platforms that give each author their
 * own subdomain (wordpress.com, substack.com, blogspot.com …) are deliberately
 * absent — `author.substack.com` is exactly what this feature is for, and only
 * the bare apex is dropped, by the subdomain rule below.
 */
export const PLATFORM_HOSTS = new Set([
  'amazon.com',
  'ebay.com',
  'etsy.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'pinterest.com',
  'quora.com',
  'reddit.com',
  'threads.net',
  'tiktok.com',
  'tumblr.com',
  'twitter.com',
  'walmart.com',
  'wikipedia.org',
  'x.com',
  'yelp.com',
  'youtube.com',
  'youtu.be',
]);

/**
 * Apexes that only ever host other people's blogs.
 *
 * A result on the apex itself is the platform's own marketing page; a result on
 * a subdomain is somebody's blog. So these are dropped at the apex and kept
 * everywhere else.
 */
export const BLOG_PLATFORM_APEXES = new Set([
  'blogger.com',
  'blogspot.com',
  'bearblog.dev',
  'ghost.io',
  'medium.com',
  'micro.blog',
  'substack.com',
  'wordpress.com',
  'write.as',
]);

/**
 * Split a keyword paste into individual keywords.
 *
 * Newlines and commas only — never whitespace. A keyword is a phrase, and
 * "siberian huskies" is one search, not two.
 *
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {string[]} deduped, case-insensitively, in input order
 */
export function parseKeywords(raw, max = MAX_KEYWORDS) {
  const seen = new Set();
  const out = [];

  for (const part of String(raw ?? '').split(/[\n,]+/)) {
    const keyword = part.trim().replace(/\s+/g, ' ');
    if (!keyword) continue;

    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(keyword);
    if (out.length >= max) break;
  }

  return out;
}

/**
 * The registrable-ish apex of a hostname.
 *
 * Deliberately naive — the last two labels — because the only thing it decides
 * is denylist membership, and the denylist is all ordinary two-label domains.
 * A miss on a multi-part TLD (foo.co.uk → co.uk) lets a candidate through,
 * which is the harmless direction.
 *
 * @param {string} hostname
 * @returns {string}
 */
export function apexOf(hostname) {
  const parts = hostname.toLowerCase().replace(/^www\./, '').split('.');
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

/**
 * Is this search result worth a fetch?
 *
 * @param {string} link
 * @returns {boolean}
 */
export function isCandidateLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const apex = apexOf(host);

  if (PLATFORM_HOSTS.has(apex)) return false;
  // Platform apex = marketing page; platform subdomain = somebody's blog.
  if (BLOG_PLATFORM_APEXES.has(apex) && host === apex) return false;

  // A PDF or an image is not a blog, and fetching it wastes the budget.
  if (/\.(?:pdf|jpe?g|png|gif|webp|svg|mp[34]|zip|docx?|xlsx?)$/i.test(url.pathname)) return false;

  return true;
}

/**
 * Collapse search results to one candidate per site.
 *
 * A keyword search returns ten pages from the same good blog; each is the same
 * candidate, because feed discovery starts at the site root either way. The
 * keyword that first surfaced a site is kept for the status page — it is the
 * only explanation a human wants for why some site is in their run.
 *
 * @param {Array<{ ok?: boolean, keyword?: string, links?: string[] }>} results
 * @returns {Array<{ url: string, host: string, keyword: string }>}
 */
export function candidateSites(results) {
  const byHost = new Map();

  for (const result of results) {
    if (!result?.ok) continue;

    for (const link of result.links ?? []) {
      if (!isCandidateLink(link)) continue;

      let url;
      try {
        url = new URL(link);
      } catch {
        continue;
      }

      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      if (byHost.has(host)) continue;

      // The site root, not the ranked page. Feed discovery wants the homepage's
      // <link rel="alternate">, and a deep article URL often has none.
      byHost.set(host, {
        url: `${url.protocol}//${url.hostname}/`,
        host,
        keyword: result.keyword ?? '',
      });
    }
  }

  return [...byHost.values()];
}
