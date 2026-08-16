import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Full-text search across posts and blogs.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const url = new URL(req.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30) || 30, 1), 100);

  if (!query) return json({ query: '', blogs: [], posts: [] });

  const client = db();
  const [blogs, posts] = await Promise.all([
    q.searchFeeds(client, query, limit),
    q.searchItems(client, query, limit),
  ]);

  return json({
    query,
    blogs: blogs.map((b) => ({
      slug: b.slug,
      title: b.title,
      description: b.description,
      page: `${siteUrl()}/${b.slug}`,
    })),
    posts: posts.map((p) => ({
      title: p.title,
      url: p.url,
      summary: p.summary,
      publishedAt: p.published_at,
      blog: p.feed_title,
      blogPage: `${siteUrl()}/${p.feed_slug}`,
    })),
  });
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
    },
  });
}
