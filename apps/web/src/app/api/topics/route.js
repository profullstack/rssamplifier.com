import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * The topics index, as JSON.
 *
 * `?min=` raises the bar — `?min=10` is "subjects at least ten feeds cover".
 * It cannot be lowered below two: a topic carried by one feed is that blog's
 * own vocabulary rather than a subject the directory covers, and the index this
 * reads is built without them. The long tail is not hidden, it is per-feed —
 * every feed's own topics are on its page and in /api/feeds/{slug}.
 *
 * `?q=` searches the index. Without it there are forty thousand topics ordered
 * by how many feeds carry them, so the only way to reach a specific subject was
 * to page through the whole rollup — which made "what does this directory have
 * about homelabs" an expensive question to ask from outside.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const url = new URL(req.url);
  const limit = clamp(url.searchParams.get('limit'), 200, 1000);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
  const minFeeds = clamp(url.searchParams.get('min'), 2, 100, 2);
  const query = (url.searchParams.get('q') ?? '').trim() || null;

  const client = db();
  const [rows, total] = await Promise.all([
    q.listTopics(client, { limit, offset, minFeeds, query }),
    q.countTopics(client, minFeeds, query),
  ]);

  return json({
    total,
    query,
    limit,
    offset,
    minFeeds,
    topics: rows.map((t) => ({
      slug: t.slug,
      keyword: t.keyword,
      feedCount: Number(t.feed_count ?? 0),
      page: `${siteUrl()}/topics/${encodeURIComponent(String(t.slug))}`,
      feeds: `${siteUrl()}/api/topics/${encodeURIComponent(String(t.slug))}`,
      // The subscription list for this topic, which is the artifact a reader or
      // another tool actually consumes.
      opml: `${siteUrl()}/opml?topic=${encodeURIComponent(String(t.slug))}`,
    })),
  });
}

/**
 * @param {string|null} raw
 * @param {number} fallback
 * @param {number} max
 * @param {number} [min]
 * @returns {number}
 */
function clamp(raw, fallback, max, min = 1) {
  const n = Number(raw ?? fallback) || fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * @param {unknown} body
 * @returns {Response}
 */
function json(body) {
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}
