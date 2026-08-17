import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { guard } from '../../../lib/apiguard.js';

export const dynamic = 'force-dynamic';

/**
 * Full-text search across posts and blogs.
 *
 * `mode=any` matches posts carrying any one of the terms rather than all of
 * them. That exists for callers that know a thing by several names and want
 * the union — a ticker and its company, say, where the blogosphere writes
 * "NVIDIA" far more often than "NVDA". Default stays `all`.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const allowed = await guard(req);
  if (!allowed.ok) return allowed.response;

  const url = new URL(req.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30) || 30, 1), 100);
  const mode = url.searchParams.get('mode') === 'any' ? 'any' : 'all';

  if (!query) return json({ query: '', mode, blogs: [], posts: [] }, allowed.headers);

  const client = db();
  const [blogs, posts] = await Promise.all([
    q.searchFeeds(client, query, limit, mode),
    q.searchItems(client, query, limit, mode),
  ]);

  return json({
    query,
    mode,
    blogs: blogs.map((b) => ({
      slug: b.slug,
      title: b.title,
      description: b.description,
      page: `${siteUrl()}/${b.slug}`,
    })),
    posts: posts.map((p) => ({
      title: p.title,
      // `url` is the post where it lives; `readUrl` is the same post in our
      // reader, framed with a way out to the original in the footer. A caller
      // rendering a list of results should link the second one.
      url: p.url,
      readUrl: p.guid
        ? `${siteUrl()}/${p.feed_slug}/read?p=${encodeURIComponent(String(p.guid))}`
        : null,
      summary: p.summary,
      publishedAt: p.published_at,
      blog: p.feed_title,
      blogPage: `${siteUrl()}/${p.feed_slug}`,
    })),
  }, allowed.headers);
}

/**
 * @param {unknown} body
 * @param {Record<string, string>} [extra] rate-limit headers from the guard
 * @returns {Response}
 */
function json(body, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...extra,
    },
  });
}
