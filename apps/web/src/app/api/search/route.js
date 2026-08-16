import { db, siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Full-text search across posts and blogs.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 30) || 30, 100);

  if (!q) {
    return json({ query: '', posts: [], blogs: [] });
  }

  const sb = db();

  // websearch_to_tsquery accepts quoted phrases and -exclusions, which is what
  // someone typing into a search box expects.
  const [posts, blogs] = await Promise.all([
    sb
      .from('feed_items')
      .select('title, url, summary, published_at, feeds!inner(slug, title)')
      .textSearch('search_tsv', q, { type: 'websearch', config: 'english' })
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(limit),
    sb
      .from('feeds')
      .select('slug, title, description')
      .textSearch('search_tsv', q, { type: 'websearch', config: 'english' })
      .limit(limit),
  ]);

  return json({
    query: q,
    blogs: (blogs.data ?? []).map((b) => ({ ...b, page: `${siteUrl()}/${b.slug}` })),
    posts: (posts.data ?? []).map((p) => ({
      title: p.title,
      url: p.url,
      summary: p.summary,
      publishedAt: p.published_at,
      blog: p.feeds?.title,
      blogPage: p.feeds?.slug ? `${siteUrl()}/${p.feeds.slug}` : null,
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
