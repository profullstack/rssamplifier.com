import { db, siteUrl } from '../../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * One feed with its recent items, as JSON.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug } = await params;
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);

  const sb = db();
  const { data: feed } = await sb.from('feeds').select('*').eq('slug', slug).maybeSingle();

  if (!feed) {
    return new Response(JSON.stringify({ error: 'not-found' }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    });
  }

  const { data: items } = await sb
    .from('feed_items')
    .select('guid, url, title, summary, author, published_at, image_url')
    .eq('feed_id', feed.id)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  return new Response(
    JSON.stringify(
      {
        slug: feed.slug,
        title: feed.title,
        description: feed.description,
        siteUrl: feed.site_url,
        feedUrl: feed.feed_url,
        language: feed.language,
        status: feed.status,
        itemCount: feed.item_count,
        lastSuccessAt: feed.last_success_at,
        page: `${siteUrl()}/${feed.slug}`,
        items: items ?? [],
      },
      null,
      2,
    ),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=300',
      },
    },
  );
}
