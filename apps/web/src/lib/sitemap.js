/**
 * Shared sitemap vocabulary.
 *
 * The index and the chunk routes have to agree exactly on how a chunk is named
 * and how that name is read back, so both live here rather than being written
 * twice and drifting apart.
 */

/**
 * URLs per chunk file.
 *
 * The sitemap spec caps a file at 50,000 URLs and 50MB. 20,000 leaves room for
 * both without producing so many files that the index becomes the problem.
 */
export const CHUNK_SIZE = 20_000;

/**
 * Static pages, listed in their own chunk so the blog chunks stay uniform.
 *
 * /login is deliberately absent — it is the same form as /signup for somebody
 * who already knows the answer, and two entries for one mechanism is the sort
 * of near-duplicate a sitemap should not be volunteering.
 */
export const STATIC_PAGES = [
  { path: '', changefreq: 'hourly', priority: '1.0' },
  // The category pages rank alongside the index: they are the two entry points
  // into the directory that are about something, and both change as often as it
  // does. Only page 1 of each is listed — the pager links the rest, and a
  // sitemap that enumerated every page of a paginated list would be listing the
  // same blogs a second time under a different URL.
  { path: '/blogs', changefreq: 'hourly', priority: '0.9' },
  { path: '/news', changefreq: 'hourly', priority: '0.9' },
  { path: '/podcasts', changefreq: 'hourly', priority: '0.9' },
  { path: '/music', changefreq: 'hourly', priority: '0.9' },
  { path: '/videos', changefreq: 'hourly', priority: '0.9' },
  { path: '/comics', changefreq: 'daily', priority: '0.8' },
  { path: '/lives', changefreq: 'daily', priority: '0.7' },
  { path: '/reels', changefreq: 'daily', priority: '0.7' },
  { path: '/topics', changefreq: 'daily', priority: '0.8' },
  { path: '/authors', changefreq: 'daily', priority: '0.8' },
  // The two platform namespaces, alongside the categories for the same reason:
  // they are entry points into the directory that are about something.
  //
  // Only the index of each. The individual sources are already in the blog
  // chunks under their `/{slug}` URL, and listing them a second time under
  // `/r/…` and `/x/…` is exactly the duplicate a sitemap should not volunteer —
  // the canonical tag on each page is what tells a crawler which of the two
  // addresses to keep, and it does not need the sitemap's help to do it.
  { path: '/r', changefreq: 'daily', priority: '0.8' },
  { path: '/x', changefreq: 'daily', priority: '0.8' },
  { path: '/search', changefreq: 'daily', priority: '0.8' },
  { path: '/submit', changefreq: 'weekly', priority: '0.7' },
  { path: '/signup', changefreq: 'monthly', priority: '0.6' },
  // How to connect an agent to the directory. Listed because the people who
  // would use it are the ones searching for it, and it is not linked from
  // anywhere a crawler weights heavily.
  { path: '/mcp', changefreq: 'monthly', priority: '0.6' },
  { path: '/about', changefreq: 'monthly', priority: '0.5' },
  { path: '/contact', changefreq: 'yearly', priority: '0.4' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
  // Monthly rather than yearly like the other legal page: the availability
  // figures on it are live, so the page genuinely does change.
  { path: '/terms', changefreq: 'monthly', priority: '0.3' },
];

/**
 * Filename for a chunk, without the `/sitemaps/` prefix.
 *
 * Part 1 keeps the bare `blogs-YYYY-MM.xml` name, so a month that fits in one
 * file — every month at normal submission rates — reads exactly like the
 * single-file case and only a bulk-import month grows `-2`, `-3` siblings.
 *
 * @param {{ month: string, part?: number }} chunk
 * @returns {string}
 */
export function chunkFilename({ month, part = 1 }) {
  return part === 1 ? `blogs-${month}.xml` : `blogs-${month}-${part}.xml`;
}

/**
 * Read a chunk filename back into a month and part.
 *
 * Returns null for anything that is not a well-formed chunk name, so an
 * arbitrary path under /sitemaps/ 404s instead of running a query built from
 * whatever the URL happened to contain.
 *
 * @param {string} filename
 * @returns {{ month: string, part: number }|null}
 */
export function parseChunkFilename(filename) {
  const match = /^blogs-(\d{4}-\d{2})(?:-(\d+))?\.xml$/.exec(filename);
  if (!match) return null;

  const part = match[2] === undefined ? 1 : Number(match[2]);
  // `-1` is not a legal spelling of part 1: it would serve the same file under
  // two URLs, which is a duplicate-content signal to exactly the crawlers this
  // exists for.
  if (!Number.isInteger(part) || part < 1 || match[2] === '1') return null;

  return { month: match[1], part };
}

/**
 * Escape a value for XML text content.
 *
 * @param {unknown} v
 * @returns {string}
 */
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
