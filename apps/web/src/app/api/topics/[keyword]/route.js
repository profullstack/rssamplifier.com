import { q } from '@rssamplifier/db';
import { topicSlug } from '@rssamplifier/feed';

import { db, siteUrl } from '../../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Every feed filed under one topic, as JSON.
 *
 * The keyword is normalised the same way the page normalises it, so an agent
 * can pass a phrase it read anywhere — "Home Lab", "home-lab" — rather than
 * having to know the slug.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ keyword: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { keyword } = await params;
  const slug = topicSlug(decodeURIComponent(String(keyword ?? '')));

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);

  const client = db();
  const topic = await q.topicBySlug(client, slug);

  if (!topic) {
    return new Response(JSON.stringify({ error: 'not-found', slug }, null, 2), {
      status: 404,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      },
    });
  }

  const rows = await q.feedsForTopic(client, slug, { limit, offset });

  return new Response(
    JSON.stringify(
      {
        slug: topic.slug,
        keyword: topic.keyword,
        total: topic.feedCount,
        limit,
        offset,
        page: `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}`,
        feeds: rows.map((f) => ({
          slug: f.slug,
          title: f.title,
          description: f.description,
          siteUrl: f.site_url,
          kind: f.category,
          itemCount: f.item_count,
          // How this feed came to be on this topic: the publisher's own tag, or
          // a phrase counted across its writing.
          source: f.source,
          strength: Number(f.count ?? 0),
          page: `${siteUrl()}/${f.slug}`,
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
