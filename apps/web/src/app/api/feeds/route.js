import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Every feed in the directory — the agent-facing entry point.
 *
 * CORS-open, paginated, no key required.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const url = new URL(req.url);
  const limit = clamp(url.searchParams.get('limit'), 100, 500);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);

  const client = db();
  const [rows, total] = await Promise.all([
    q.listFeeds(client, { limit, offset }),
    q.countFeeds(client),
  ]);

  return json({
    total,
    limit,
    offset,
    feeds: rows.map((f) => ({
      slug: f.slug,
      title: f.title,
      description: f.description,
      siteUrl: f.site_url,
      feedUrl: f.feed_url,
      language: f.language,
      itemCount: f.item_count,
      status: f.status,
      lastSuccessAt: f.last_success_at,
      page: `${siteUrl()}/${f.slug}`,
    })),
  });
}

/**
 * @param {string|null} raw
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function clamp(raw, fallback, max) {
  const n = Number(raw ?? fallback) || fallback;
  return Math.min(Math.max(n, 1), max);
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
