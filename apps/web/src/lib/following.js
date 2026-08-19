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
 * @param {import('@libsql/client').Client} client
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
  } = opts;

  const [feeds, topics, authors] = await Promise.all([
    accounts.followedFeeds(client, userId),
    accounts.followedTopics(client, userId),
    accounts.followedAuthors(client, userId),
  ]);

  const drawnFrom = topics.slice(0, riverTopics);
  const peopleDrawnFrom = authors.slice(0, riverAuthors);

  const [feedItems, topicItems, authorItems] = await Promise.all([
    feeds.length ? accounts.followedItems(client, userId, PER_SOURCE) : Promise.resolve([]),
    Promise.all(
      drawnFrom.map(async (follow) => {
        const label = topicLabel(follow);
        const group = label.segment ? topicGroup(label.segment) : null;

        return {
          via: { kind: 'topic', title: label.title, href: label.href },
          rows: await q.itemsForTopic(client, String(follow.slug), {
            limit: PER_SOURCE,
            kinds: group?.kinds ?? null,
            // Collapsed once in mergeRiver, over every source at the same time,
            // so paying for the overread per topic would buy nothing.
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
        rows: await people.postsByAuthorId(client, String(follow.id), PER_SOURCE),
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
 * @param {string} origin absolute site origin, no trailing slash
 * @param {string} token
 * @param {string} [format]
 * @returns {string}
 */
export function followingFeedUrl(origin, token, format = 'rss') {
  return `${origin}/following.${format}?t=${encodeURIComponent(token)}`;
}
