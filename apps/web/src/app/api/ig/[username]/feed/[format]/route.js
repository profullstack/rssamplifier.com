import { riverFail } from '../../../../../../lib/river.js';
import { instagramTarget, socialRiver } from '../../../../../../lib/socialRiver.js';

export const dynamic = 'force-dynamic';

/**
 * One Instagram account, as a feed of ours. `/ig/nasa.rss` rewrites here.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ username: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { username, format } = await params;
  const url = new URL(req.url);

  const target = instagramTarget({ username });
  if (!target) {
    return riverFail(
      format,
      400,
      `not an Instagram handle: ${username}`,
      'Handles are up to 30 characters of A-Z, 0-9, dot and underscore.',
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
