import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { guard } from '../../../lib/apiguard.js';
import { freshness } from '../../../lib/freshness.js';

export const dynamic = 'force-dynamic';

/**
 * Every feed in the directory — the agent-facing entry point.
 *
 * CORS-open, paginated, no key required. `?kind=blog` or `?kind=podcast`
 * narrows it to one category; an unrecognised kind is ignored rather than
 * rejected, so a caller that guesses wrong gets the whole directory instead of
 * an error page it has to parse.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const allowed = await guard(req);
  if (!allowed.ok) return allowed.response;

  const url = new URL(req.url);
  const limit = clamp(url.searchParams.get('limit'), 100, 500);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
  const kind = q.normalizeKind(url.searchParams.get('kind'));

  const client = db();
  const [rows, total] = await Promise.all([
    q.listFeeds(client, { limit, offset, kind }),
    q.countFeeds(client, false, kind),
  ]);

  return json(
    {
      total,
      limit,
      offset,
      kind,
      kinds: q.KINDS,
      feeds: rows.map((f) => {
        const fresh = freshness(f, f.last_published_at);
        return {
        slug: f.slug,
        title: f.title,
        description: f.description,
        siteUrl: f.site_url,
        feedUrl: f.feed_url,
        language: f.language,
        kind: f.category,
        itemCount: f.item_count,
        status: f.status,
        lastSuccessAt: f.last_success_at,
        // Whether this feed is worth trusting, answered rather than implied.
        // `lastSuccessAt` alone says when we last read the publisher and
        // nothing about whether the publisher is still publishing -- and about
        // a sixth of the directory is dormant, current as of minutes ago and
        // silent since 2023. See lib/freshness.js.
        freshness: fresh.state,
        lastPublishedAt: fresh.publishedAt,
        nextCheckAt: fresh.nextCheckAt,
        page: `${siteUrl()}/${f.slug}`,
        };
      }),
    },
    allowed.headers,
  );
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
 * @param {Record<string, string>} [extra] rate-limit headers from the guard
 * @returns {Response}
 */
function json(body, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
      ...extra,
    },
  });
}
