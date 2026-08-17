import { topicFeed } from '../../../../../../../lib/topicFeed.js';

export const dynamic = 'force-dynamic';

/**
 * One category of one topic, as a feed. `/topics/physics/podcasts.rss` rewrites
 * onto this.
 *
 * A route of its own rather than a query parameter on the one next door,
 * because a rewrite's destination query string does not survive the trip to an
 * App Router handler — see lib/topicFeed.js, which both routes are.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ keyword: string, group: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { keyword, group, format } = await params;

  return topicFeed({
    keyword,
    format,
    group,
    limit: new URL(req.url).searchParams.get('limit'),
    req,
  });
}
