import { q } from '@rssamplifier/db';

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
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);

  const client = db();
  const feed = await q.feedBySlug(client, slug);

  if (!feed) {
    return new Response(JSON.stringify({ error: 'not-found' }), {
      status: 404,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      },
    });
  }

  const [items, topics] = await Promise.all([
    q.itemsForFeed(client, String(feed.id), limit),
    // A feed's full topic set, including the ones no other feed shares — those
    // are absent from /api/topics by design, and this is where they live.
    q.keywordsForFeed(client, String(feed.id), 25),
  ]);

  return new Response(
    JSON.stringify(
      {
        slug: feed.slug,
        title: feed.title,
        description: feed.description,
        siteUrl: feed.site_url,
        feedUrl: feed.feed_url,
        language: feed.language,
        kind: feed.category,
        status: feed.status,
        itemCount: feed.item_count,
        lastSuccessAt: feed.last_success_at,
        page: `${siteUrl()}/${feed.slug}`,
        topics: topics.map((t) => ({
          slug: t.slug,
          keyword: t.keyword,
          // 'category' is the publisher's own tag, 'content' is counted from
          // the feed's text.
          source: t.source,
          strength: Number(t.count ?? 0),
          page: `${siteUrl()}/topics/${encodeURIComponent(String(t.slug))}`,
        })),
        items: items.map((i) => ({
          guid: i.guid,
          url: i.url,
          title: i.title,
          summary: i.summary,
          author: i.author,
          imageUrl: i.image_url,
          publishedAt: i.published_at,
        })),
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
