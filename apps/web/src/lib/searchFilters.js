import { CATEGORIES } from './categories.js';
import { TOPIC_GROUPS, topicGroup } from './topicGroups.js';

/**
 * A set of results, cut by what kind of thing matched.
 *
 * The directory is nine parts blog by volume, so the forty best matches for
 * anything are forty blog posts — the podcasts, channels and netlabels that
 * matched are in the result set and never on the screen, which reads as a search
 * that only covers blogs. These are the same cut a topic gets, over a query
 * instead of a keyword, and they deliberately use the topic sub-groups' own
 * vocabulary and segment names: /topics/physics/podcasts and
 * /search?q=physics&kind=podcasts should mean the same word.
 */

/** The segment each category is filtered by: podcast → podcasts. */
const SEGMENT_FOR_KIND = Object.fromEntries(
  Object.entries(CATEGORIES).map(([kind, category]) => [kind, category.path.replace(/^\//, '')]),
);

/**
 * The filter a `kind` parameter names, or null for the whole result set.
 *
 * Takes the singular category as well as the plural segment, because `podcast`
 * is what the database calls it, what /api/feeds takes, and what somebody
 * hand-writing a URL is most likely to type. Anything unrecognised — including
 * a category that no longer exists — comes back null, which is the unfiltered
 * page rather than an error: a mistyped filter should cost you the narrowing,
 * not the results.
 *
 * @param {unknown} raw
 * @returns {(typeof TOPIC_GROUPS)[number]|null}
 */
export function searchFilter(raw) {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!value) return null;

  return topicGroup(SEGMENT_FOR_KIND[value] ?? value);
}

/**
 * Every filter with something behind it, and how much it has.
 *
 * Counts are posts and feeds added together, which is what the filter itself
 * covers: choosing Podcasts narrows the episodes *and* the shows. Empty filters
 * are dropped rather than shown as zero — a row of eight links to "no comics
 * matched" is eight ways to waste a click, and on most queries that is most of
 * the row.
 *
 * @param {{ posts: Record<string, number>, feeds: Record<string, number> }} counts
 * @returns {Array<{ group: (typeof TOPIC_GROUPS)[number], count: number }>}
 */
export function filtersWithHits(counts) {
  const total = (/** @type {string} */ kind) =>
    (counts.posts?.[kind] ?? 0) + (counts.feeds?.[kind] ?? 0);

  return TOPIC_GROUPS.map((group) => ({
    group,
    count: group.kinds.reduce((sum, kind) => sum + total(kind), 0),
  })).filter((entry) => entry.count > 0);
}

/**
 * Everything the query matched, across every category.
 *
 * Not a sum of the row above: `audio` is podcasts and music counted a second
 * time, so adding the filters up would over-count every query that matched
 * either.
 *
 * @param {{ posts: Record<string, number>, feeds: Record<string, number> }} counts
 * @returns {number}
 */
export function totalHits(counts) {
  const sum = (/** @type {Record<string, number>} */ tally) =>
    Object.values(tally ?? {}).reduce((total, n) => total + n, 0);

  return sum(counts.posts) + sum(counts.feeds);
}

/**
 * The /search URL for one filter, carrying the query with it.
 *
 * @param {string} q
 * @param {string|null} [kind] a filter's segment, or null for everything
 * @returns {string}
 */
export function searchHref(q, kind = null) {
  const search = new URLSearchParams({ q });
  if (kind) search.set('kind', kind);
  return `/search?${search}`;
}
