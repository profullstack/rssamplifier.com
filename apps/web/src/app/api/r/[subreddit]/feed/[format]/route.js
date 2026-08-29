import { riverFail } from '../../../../../../lib/river.js';
import { redditTarget, socialRiver } from '../../../../../../lib/socialRiver.js';

export const dynamic = 'force-dynamic';

/**
 * One subreddit, as a feed of ours. `/r/programming.rss` rewrites here.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ subreddit: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { subreddit, format } = await params;
  const url = new URL(req.url);

  const target = redditTarget({ subreddit });
  // 400 rather than 404 (§41): the name cannot be a subreddit at all, so there
  // is nothing to look for and nothing that adding it would fix.
  if (!target) {
    return riverFail(
      format,
      400,
      `not a subreddit: r/${subreddit}`,
      'Subreddit names are 3-21 characters of A-Z, 0-9 and underscore.',
    );
  }

  return socialRiver({
    ref: target.ref,
    canonical: target.canonical,
    label: target.label,
    format,
    limit: url.searchParams.get('limit'),
    req,
  });
}
