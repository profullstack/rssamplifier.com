import { riverFail } from '../../../../../../../lib/river.js';
import { redditTarget, socialRiver } from '../../../../../../../lib/socialRiver.js';

export const dynamic = 'force-dynamic';

/**
 * One Reddit user's posts. `/r/u/spez.rss` rewrites here.
 *
 * Under `/r/` rather than at a `/u/` of its own, so that one prefix holds all
 * of Reddit — which is the whole point of having the namespace.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ username: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { username, format } = await params;
  const url = new URL(req.url);

  const target = redditTarget({ username });
  if (!target) {
    return riverFail(
      format,
      400,
      `not a Reddit username: ${username}`,
      'Usernames are 3-20 characters of A-Z, 0-9, underscore and hyphen.',
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
