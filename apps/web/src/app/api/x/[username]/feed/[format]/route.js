import { riverFail } from '../../../../../../lib/river.js';
import { socialRiver, xTarget } from '../../../../../../lib/socialRiver.js';

export const dynamic = 'force-dynamic';

/**
 * One X account's timeline, as a feed of ours. `/x/OpenAI.rss` rewrites here.
 *
 * The address AC-2 is about. Which provider collected these posts — RSSHub,
 * Teapot, the official API — appears nowhere in the URL, the document or the
 * headers, so the collection method can be replaced under a live subscriber
 * without their reader noticing.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ username: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { username, format } = await params;
  const url = new URL(req.url);

  const target = xTarget({ username });
  if (!target) {
    return riverFail(
      format,
      400,
      `not an X handle: ${username}`,
      'Handles are 1-15 characters of A-Z, 0-9 and underscore.',
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
