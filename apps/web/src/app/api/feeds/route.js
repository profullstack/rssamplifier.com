import { db, siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * List every feed in the directory.
 *
 * The agent-facing entry point: CORS-open, paginated, no key required.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);

  const sb = db();
  const { data, count } = await sb
    .from('feeds')
    .select('slug, title, description, site_url, feed_url, language, item_count, status, last_success_at', {
      count: 'exact',
    })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return json({
    total: count ?? 0,
    limit,
    offset,
    feeds: (data ?? []).map((f) => ({ ...f, page: `${siteUrl()}/${f.slug}` })),
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
      'cache-control': 'public, max-age=300',
    },
  });
}
