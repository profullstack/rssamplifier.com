import { riverFail } from '../../../../../../../lib/river.js';
import { instagramTarget, socialRiver } from '../../../../../../../lib/socialRiver.js';

export const dynamic = 'force-dynamic';

/**
 * One Instagram hashtag. `/ig/tag/coffee.rss` rewrites here.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ tag: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { tag, format } = await params;
  const url = new URL(req.url);

  const target = instagramTarget({ tag });
  if (!target) {
    return riverFail(
      format,
      400,
      `not an Instagram hashtag: ${tag}`,
      'Hashtags are letters, digits and underscore.',
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
