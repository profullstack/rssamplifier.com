import { accounts, authors as people, q } from '@rssamplifier/db';
import { dedupeItems } from '@rssamplifier/feed';

import { topicGroup } from './topicGroups.js';

/**
 * One reader's river: everything they follow, in one list.
 *
 * Three kinds of follow feed it. A followed **blog** is a publication — tell me
 * when these people post. A followed **topic** is a subject — tell me when
 * anybody posts about this — and it may be narrowed to one category of that
 * topic, so /topics/ai and /topics/ai/podcasts are followed separately the way
 * they are browsed separately. A followed **author** is a person, which is none
 * of the above: somebody with a blog, a newsletter and a podcast is three
 * publications, and following the person is the only way to ask for all three
 * and for the fourth they have not started yet.
 *
 * All three end up in the same merged list, because the reader did not ask for
 * three lists. What the list keeps per row is where it came from: `via` names the
 * follow that pulled it in, so a post that turned up because of a topic can say
 * so instead of appearing to come from a blog nobody remembers following.
 */

/**
 * How many followed topics the river draws from.
 *
 * A cap, and a load-bearing one. A topic river is one query per topic against
 * the tuned path in itemsForTopic — about 100ms each on production data, and
 * they run in parallel — but a reader who follows two hundred topics would turn
 * one page load into two hundred round trips to a network database. Twelve keeps
 * the page inside a second in the worst case, and the page says out loud when it
 * has left some out rather than quietly serving a partial answer.
 *
 * The ones that count are the most recently followed, which is the half a reader
 * is most likely to still care about.
 */
export const RIVER_TOPICS = 12;

/**
 * How many followed people the river draws from.
 *
 * The same cap as topics and for the same reason, one query each. Set to the
 * same number rather than a tuned one: an author query reads at most twenty
 * feeds by primary key and is cheaper than a topic's, so if twelve topics are
 * affordable then twelve people certainly are.
 */
export const RIVER_AUTHORS = 12;

/**
 * How many posts a following river carries, on the page and in the feed.
 *
 * One number for both, so a reader who subscribes to their own feed and then
 * opens the page sees the same thing in the same order.
 */
export const RIVER_LIMIT = 60;

/**
 * How many posts are read from each source before merging.
 *
 * Deliberately the whole river's length rather than a share of it: a reader may
 * follow twelve topics of which one is publishing this week, and dividing the
 * budget evenly would hold that topic to five posts while eleven quiet ones
 * contributed nothing.
 */
const PER_SOURCE = RIVER_LIMIT;

/**
 * What people type for a category that is not what the directory calls it.
 *
 * "rss" is the one that matters: the directory's word for a text feed is
 * `blog`, and half the people who have one call the whole idea RSS. A filter
 * that 404s on the word its own readers use is a filter that looks broken.
 */
const KIND_ALIASES = new Map([
  ['rss', 'blog'],
  ['blogs', 'blog'],
  ['feeds', 'blog'],
  ['text', 'blog'],
  ['podcasts', 'podcast'],
  ['audio', 'podcast'],
  ['videos', 'video'],
  ['video', 'video'],
  ['comics', 'comic'],
  ['lives', 'live'],
  ['reels', 'reel'],
]);

/**
 * Read `?kind=` as the categories a river should be narrowed to.
 *
 * Null — every kind — for anything unrecognised, on the same reasoning as
 * `pageNumber`: this is a parameter in a URL people edit, share and guess at,
 * and a personal river has no business refusing to render over one. Returning
 * "everything" is also the safe direction to be wrong in: the reader sees more
 * than they asked for rather than an empty page they cannot explain.
 *
 * @param {unknown} raw
 * @returns {string[]|null}
 */
export function riverKinds(raw) {
  const value = String(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''))
    .trim()
    .toLowerCase();
  if (!value || value === 'all') return null;

  const kind = KIND_ALIASES.get(value) ?? value;
  return q.KINDS.includes(kind) ? [kind] : null;
}

/**
 * The kinds worth offering as filters to one particular reader.
 *
 * Built from what this account follows rather than from the eight the directory
 * has, because a chip that can only ever be empty is worse than no chip: it
 * reads as "you have no podcasts this week" when the truth is "you follow no
 * podcasts". Followed blogs contribute the kinds they are; a topic followed as
 * one of its sub-groups contributes that group's kinds.
 *
 * A whole-topic follow and a followed person are both wildcards — either can
 * carry anything, and neither knows what until the river is read — so one of
 * those opens the filter up to every kind.
 *
 * @param {{ feeds?: object[], topics?: object[], authors?: object[] }} follows
 * @returns {string[]} in the directory's own order
 */
export function kindsAvailable({ feeds = [], topics = [], authors = [] } = {}) {
  const wildcard =
    authors.length > 0 || topics.some((t) => !topicGroup(String(t.segment ?? '')));
  if (wildcard) return [...q.KINDS];

  const found = new Set();
  for (const feed of feeds) {
    const kind = String(feed.category ?? '');
    if (q.KINDS.includes(kind)) found.add(kind);
  }
  for (const topic of topics) {
    for (const kind of topicGroup(String(topic.segment ?? ''))?.kinds ?? []) found.add(kind);
  }

  return q.KINDS.filter((kind) => found.has(kind));
}

/**
 * What one source of the river can still contribute once a filter is on.
 *
 * Three cases, and the third is the one worth naming. No filter: the source
 * keeps whatever it already asked for. A source with no kind of its own — a
 * whole topic, a followed person — takes the filter outright. A source that
 * already names its kinds keeps the overlap, and an overlap of nothing is
 * `empty`, which callers must skip rather than pass on: an empty list of kinds
 * normalises back to "every kind" in the query layer.
 *
 * @param {string[]|null} sourceKinds
 * @param {string[]|null} filterKinds
 * @returns {{ kinds: string[]|null, empty: boolean }}
 */
export function narrow(sourceKinds, filterKinds) {
  if (!filterKinds || filterKinds.length === 0) {
    return { kinds: sourceKinds ?? null, empty: false };
  }
  if (!sourceKinds || sourceKinds.length === 0) return { kinds: [...filterKinds], empty: false };

  const both = sourceKinds.filter((kind) => filterKinds.includes(kind));
  return { kinds: both, empty: both.length === 0 };
}

/**
 * What one follow is called, and where it points.
 *
 * @param {{ slug: unknown, segment?: unknown, keyword?: unknown }} follow
 * @returns {{ title: string, href: string, segment: string }}
 */
export function topicLabel(follow) {
  const slug = String(follow.slug ?? '');
  const segment = String(follow.segment ?? '');
  const keyword = String(follow.keyword || slug);
  const group = segment ? topicGroup(segment) : null;
  const path = `/topics/${encodeURIComponent(slug)}`;

  // An unknown segment — a group renamed since the follow was made — is shown as
  // the whole topic rather than as a broken label. The follow still points
  // somewhere real, and the river still fills.
  if (!group) return { title: keyword, href: path, segment: '' };

  return {
    title: `${keyword}: ${group.heading.toLowerCase()}`,
    href: `${path}/${group.segment}`,
    segment: group.segment,
  };
}

/**
 * Merge several lists of posts into one river.
 *
 * Pure, and separate from the queries that fill it, because this is the part
 * with the decisions in it: newest first, undated last, one row per story, and
 * every survivor carrying the follow that pulled it in.
 *
 * De-duplication happens once here rather than per source, which is why the
 * sources are read with grouping off — the same post reached by two followed
 * topics is one story, and collapsing it inside each topic first would not have
 * noticed.
 *
 * @param {Array<{ via: { kind: string, title: string, href: string }, rows: object[] }>} sources
 * @param {number} [limit]
 * @returns {object[]}
 */
export function mergeRiver(sources, limit = RIVER_LIMIT) {
  const rows = (sources ?? []).flatMap(({ via, rows: list }) =>
    (list ?? []).map((row) => ({ ...row, via })),
  );

  rows.sort((a, b) => published(b) - published(a));

  // Sorted newest-first above and dedupeItems keeps the first occurrence, so the
  // telling that survives is the newest one — and its `via` is the follow that
  // got it here first.
  return dedupeItems(rows).slice(0, Math.max(1, limit));
}

/**
 * A row's publication time as a number, with undated rows sorted last.
 *
 * @param {{ published_at?: unknown }} row
 * @returns {number}
 */
function published(row) {
  const at = Date.parse(String(row.published_at ?? ''));
  return Number.isFinite(at) ? at : -Infinity;
}

/**
 * Everything one reader follows, and the river it produces.
 *
 * The follows come back alongside the posts because every caller needs both: the
 * page lists what you follow above the river, and the feed's own description
 * counts them.
 *
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} client
 * @param {string} userId
 * @param {{ limit?: number, riverTopics?: number, riverAuthors?: number }} [opts]
 * @returns {Promise<{
 *   feeds: object[],
 *   topics: object[],
 *   authors: object[],
 *   items: object[],
 *   topicsUsed: number,
 *   authorsUsed: number,
 * }>}
 */
export async function following(client, userId, opts = {}) {
  const {
    limit = RIVER_LIMIT,
    riverTopics = RIVER_TOPICS,
    riverAuthors = RIVER_AUTHORS,
    kinds = null,
  } = opts;

  const [feeds, topics, authors] = await Promise.all([
    accounts.followedFeeds(client, userId),
    accounts.followedTopics(client, userId),
    accounts.followedAuthors(client, userId),
  ]);

  const drawnFrom = topics.slice(0, riverTopics);
  const peopleDrawnFrom = authors.slice(0, riverAuthors);

  const [feedItems, topicItems, authorItems] = await Promise.all([
    feeds.length
      ? accounts.followedItems(client, userId, PER_SOURCE, { kinds })
      : Promise.resolve([]),
    Promise.all(
      drawnFrom.map(async (follow) => {
        const label = topicLabel(follow);
        const group = label.segment ? topicGroup(label.segment) : null;
        const wanted = narrow(group?.kinds ?? null, kinds);

        return {
          via: { kind: 'topic', title: label.title, href: label.href },
          // Nothing in common between the follow and the filter — a topic
          // followed as blogs, filtered to videos — is a query for nothing, so
          // it is skipped rather than run. It has to be: an empty `kinds`
          // normalises back to "every kind" in the query layer, which would
          // return the exact opposite of what was asked for.
          rows: wanted.empty
            ? []
            : await q.itemsForTopic(client, String(follow.slug), {
                limit: PER_SOURCE,
                kinds: wanted.kinds,
                // Collapsed once in mergeRiver, over every source at the same
                // time, so paying for the overread per topic would buy nothing.
                group: false,
              }),
        };
      }),
    ),
    // One source per followed person. Attributed to the person rather than to
    // the publication the row happens to carry, which is the whole reason
    // somebody follows an author instead of their blog.
    Promise.all(
      peopleDrawnFrom.map(async (follow) => ({
        via: {
          kind: 'author',
          title: String(follow.name || follow.slug),
          href: `/authors/${encodeURIComponent(String(follow.slug))}`,
        },
        rows: await people.postsByAuthorId(client, String(follow.id), PER_SOURCE, { kinds }),
      })),
    ),
  ]);

  const items = mergeRiver(
    [
      // The blogs go in as one source: they are already one query, and a post
      // from a followed blog is attributed to the blog itself, which every row
      // carries in feed_slug.
      { via: { kind: 'feed', title: '', href: '' }, rows: feedItems },
      ...topicItems,
      ...authorItems,
    ],
    limit,
  );

  return {
    feeds,
    topics,
    authors,
    items,
    topicsUsed: drawnFrom.length,
    authorsUsed: peopleDrawnFrom.length,
  };
}

/**
 * The personal feed URL for a token.
 *
 * The token is a query parameter rather than a path segment on purpose: the
 * pretty address is `/following.rss`, which is a rewrite onto the route handler,
 * and a rewrite's *destination* query never reaches an App Router handler. The
 * caller's own query does, so `?t=` is the half of the URL that survives the
 * rewrite intact.
 *
 * `kinds` rides along as `&kind=`, so a filtered river is subscribable as what
 * it is on screen: a reader who has narrowed the page to podcasts and then
 * takes the feed away should get the podcasts, not everything. One parameter
 * and one kind, matching what the chips can express.
 *
 * @param {string} origin absolute site origin, no trailing slash
 * @param {string} token
 * @param {string} [format]
 * @param {string[]|null} [kinds]
 * @returns {string}
 */
export function followingFeedUrl(origin, token, format = 'rss', kinds = null) {
  const params = new URLSearchParams({ t: String(token) });
  if (kinds?.length) params.set('kind', String(kinds[0]));

  return `${origin}/following.${format}?${params.toString()}`;
}
