import { q } from '@rssamplifier/db';

import { slugFromUrl } from './topicGroups.js';

/**
 * Several topics as one: /topics/business,saas,crypto.
 *
 * A comma in a topic URL means a list. No topic slug can contain one — the
 * slugger turns every run of punctuation into a hyphen — so a comma was never
 * part of a working single-topic address, and reading it as a separator takes
 * nothing away. Every topic surface (the page and its sub-groups, the JSON
 * endpoint, the feeds and playlists, the player, the MCP tools) resolves its
 * keyword through `resolveTopics` below, which is what keeps them one address.
 *
 * The combined view is the UNION of the listed topics: every feed filed under
 * any of them, each feed once. Its order is the single-topic order applied
 * across the set — a feed its publisher tagged with any of the topics first,
 * then by its strength summed across the topics (see q.feedsForTopic) — so a
 * feed that covers two of them rises above one that covers only one.
 */

/** The most topics one combined view takes. More is a 400, not a truncation. */
export const MAX_TOPICS = 10;

/**
 * Split a URL segment into topic slugs.
 *
 * Accepts the comma itself, `%2C` (which a client that encodes everything will
 * send), and spaces around the items. Each item is normalised exactly as a
 * single topic is, and repeats collapse, so `/topics/SaaS, saas,crypto` is two
 * topics, in the order first named.
 *
 * @param {unknown} raw the keyword segment, encoded or not
 * @returns {{ slugs: string[], list: boolean }} `list` is whether a comma was
 *   present at all, which is what decides whether this is a combined view even
 *   when only one distinct topic is left in it
 */
export function parseTopicList(raw) {
  const decoded = safeDecode(String(raw ?? ''));
  if (!decoded.includes(',')) {
    const slug = slugFromUrl(raw);
    return { slugs: slug ? [slug] : [], list: false };
  }

  const slugs = [
    ...new Set(
      decoded
        .split(',')
        .map((part) => slugFromUrl(encodeURIComponent(part.trim())))
        .filter(Boolean),
    ),
  ];
  return { slugs, list: true };
}

/**
 * A topic path segment, commas left readable.
 *
 * `encodeURIComponent` would write /topics/business%2Csaas — a working address,
 * but not the one anybody typed, and not the one a combined view should
 * canonicalise to.
 *
 * @param {string} slug one slug, or several joined by commas
 * @returns {string}
 */
export function topicSegment(slug) {
  return String(slug)
    .split(',')
    .map((part) => encodeURIComponent(part))
    .join(',');
}

/**
 * @typedef {{
 *   slug: string,
 *   keyword: string,
 *   feedCount: number,
 *   multi?: boolean,
 *   slugs?: string[],
 *   topics?: Array<{ slug: string, keyword: string, feedCount: number }>,
 *   unknown?: string[],
 * }} ResolvedTopic
 */

/**
 * The topic, or combined topics, a URL segment names.
 *
 * A single keyword resolves exactly as it always has, through q.topicBySlug.
 *
 * A list resolves to a synthetic topic whose `slug` is the known slugs joined
 * by commas (the canonical address), whose `keyword` is their names joined by
 * ", ", and whose `feedCount` is the union's distinct feed count. `slugs` is
 * what to hand the queries — every topic query takes an array for the union —
 * and `unknown` lists what was asked for and does not exist, so a page can say
 * so rather than silently showing less.
 *
 * Outcomes:
 * - `{ topic }` — something to show;
 * - `{ error: 'not-found', unknown }` — nothing named exists (404);
 * - `{ error: 'too-many', max }` — the list is longer than MAX_TOPICS (400).
 *
 * One exception for a list where nothing is known: the whole segment is tried
 * once more as a single topic, so a keyword that was always spelled with a
 * comma ("1,000 words" slugs to 1-000-words) keeps the page it had.
 *
 * @param {import('@rssamplifier/db').Client} client
 * @param {unknown} raw
 * @returns {Promise<
 *   | { topic: ResolvedTopic, error?: undefined }
 *   | { topic?: undefined, error: 'not-found', unknown: string[] }
 *   | { topic?: undefined, error: 'too-many', max: number }
 * >}
 */
export async function resolveTopics(client, raw) {
  const { slugs, list } = parseTopicList(raw);

  if (!list) {
    const topic = slugs[0] ? await q.topicBySlug(client, slugs[0]) : null;
    return topic ? { topic } : { error: 'not-found', unknown: slugs };
  }

  if (slugs.length > MAX_TOPICS) return { error: 'too-many', max: MAX_TOPICS };

  const { topics, feedCount } = await q.topicsBySlugs(client, slugs);

  if (topics.length === 0) {
    const whole = slugFromUrl(raw);
    const single = whole ? await q.topicBySlug(client, whole) : null;
    return single ? { topic: single } : { error: 'not-found', unknown: slugs };
  }

  const known = new Set(topics.map((t) => t.slug));
  const unknown = slugs.filter((slug) => !known.has(slug));

  // `/topics/business,` or `/topics/business,Business` is one topic, and is
  // that topic's own page rather than a second copy of it under another URL.
  if (topics.length === 1 && unknown.length === 0) return { topic: topics[0] };

  return {
    topic: {
      slug: topics.map((t) => t.slug).join(','),
      keyword: topics.map((t) => t.keyword).join(', '),
      feedCount,
      multi: true,
      slugs: topics.map((t) => t.slug),
      topics,
      unknown,
    },
  };
}

/**
 * resolveTopics plus the per-category counts every listing needs.
 *
 * A single topic asks both at once, as the pages always have; a list has to
 * know which of its topics exist before it can count them.
 *
 * @param {import('@rssamplifier/db').Client} client
 * @param {unknown} raw
 * @returns {Promise<{ topic: ResolvedTopic|null, counts: Record<string, number> }>}
 */
export async function resolveTopicsWithCounts(client, raw) {
  const { slugs, list } = parseTopicList(raw);

  if (!list) {
    const [found, counts] = await Promise.all([
      resolveTopics(client, raw),
      q.topicKindCounts(client, slugs[0] ?? ''),
    ]);
    return { topic: found.topic ?? null, counts };
  }

  const found = await resolveTopics(client, raw);
  if (!found.topic) return { topic: null, counts: {} };
  return { topic: found.topic, counts: await q.topicKindCounts(client, topicQueryArg(found.topic)) };
}

/**
 * What to hand a topic query for this topic: its slug, or the union's slugs.
 *
 * @param {ResolvedTopic} topic
 * @returns {string|string[]}
 */
export function topicQueryArg(topic) {
  return topic.multi && topic.slugs ? topic.slugs : topic.slug;
}

/**
 * decodeURIComponent that leaves a malformed `%` alone instead of throwing.
 *
 * @param {string} value
 * @returns {string}
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
