import { authors } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * The people behind the feeds, as JSON.
 *
 * This is the endpoint the directory exists to be able to serve. Everything
 * else here answers "what is published"; this answers "by whom, and how would
 * I reach them" — which is the question a reader wanting to say thank you and
 * a tool building an outreach list are both actually asking.
 *
 * `?network=` filters to people reachable a particular way: `?network=email`
 * for the ones who published an address, `?network=fediverse` for the ones on
 * Mastodon. `?q=` searches names. `?min=` sets the confidence floor.
 *
 * The floor exists because the extractor stores weak evidence as well as
 * strong: a byline read off one page is kept, because a second source agreeing
 * with it next month is what turns it into a fact. The default of 0.6 is the
 * same one the HTML page uses, so the API and the site agree about who counts
 * as known. Lower it deliberately if you want the long tail and can handle
 * being wrong about some of it.
 *
 * Every address in `links` was published by the author as their own. Role
 * mailboxes — info@, support@, editor@ — are dropped during extraction and
 * never reach this response, because the one thing worse than not finding
 * somebody is emailing a company switchboard believing it is a person.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const url = new URL(req.url);
  const limit = clamp(url.searchParams.get('limit'), 50, 200);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
  const minConfidence = clampFloat(url.searchParams.get('min'), 0.6);
  const network = (url.searchParams.get('network') ?? '').trim() || '';
  const query = (url.searchParams.get('q') ?? '').trim() || '';

  const client = db();
  const [rows, total, stats] = await Promise.all([
    authors.listAuthors(client, { limit, offset, minConfidence, network, query }),
    authors.countAuthors(client, { minConfidence }),
    authors.authorStats(client, { minConfidence }),
  ]);

  return json({
    // `total` counts everyone above the floor, not everyone matching the
    // filters — paging is driven by the page's own length, and a count that
    // needed its own filtered query per request is not worth the round trip.
    total,
    reachable: stats.reachable,
    // Blogs that publish an account but name nobody. Not authors, and not in
    // the list below — see /api/feeds/{slug}.links, which is where they live.
    feedsWithLinks: stats.feedsWithLinks,
    limit,
    offset,
    minConfidence,
    network: network || null,
    query: query || null,
    authors: rows.map((person) => shape(person)),
  });
}

/**
 * One author, in the shape both this route and /api/authors/{slug} return.
 *
 * @param {any} person
 * @returns {object}
 */
export function shape(person) {
  return {
    slug: String(person.slug),
    name: String(person.name),
    bio: person.bio ?? null,
    avatar: person.avatar_url ?? null,
    site: person.site_url ?? null,
    email: person.email ?? null,
    // How sure we are, republished rather than hidden: a consumer that wants
    // only the certain ones should be able to make that choice itself.
    confidence: Number(person.confidence ?? 0),
    feedCount: person.feed_count == null ? undefined : Number(person.feed_count),
    page: `${siteUrl()}/authors/${encodeURIComponent(String(person.slug))}`,
    links: (person.links ?? []).map((link) => ({
      network: link.network,
      url: link.url,
      handle: link.handle,
      // Where we read it. A consumer that trusts rel="me" and not a footer
      // icon can say so without having to re-crawl the site itself.
      source: link.source,
      verified: Boolean(link.verified),
    })),
  };
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
 * @param {string|null} raw
 * @param {number} fallback
 * @returns {number}
 */
function clampFloat(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0), 1);
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
    },
  });
}
