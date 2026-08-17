import { topicFeed } from '../../../../../../lib/topicFeed.js';

export const dynamic = 'force-dynamic';

/**
 * A whole topic, as a feed. `/topics/physics.rss` rewrites onto this.
 *
 * `?group=` also narrows it here, for a caller reading the API directly. The
 * pretty URLs use a segment instead — see lib/topicFeed.js for why a rewrite
 * cannot pass a query parameter to a route handler.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ keyword: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { keyword, format } = await params;
  const url = new URL(req.url);

  return topicFeed({
    keyword,
    format,
    group: url.searchParams.get('group'),
    limit: url.searchParams.get('limit'),
    req,
  });
}
