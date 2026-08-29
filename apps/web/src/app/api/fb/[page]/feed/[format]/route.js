import { riverFail } from '../../../../../../lib/river.js';
import { facebookTarget, socialRiver } from '../../../../../../lib/socialRiver.js';

export const dynamic = 'force-dynamic';

/**
 * One Facebook Page, as a feed of ours. `/fb/SomePage.rss` rewrites here.
 *
 * A Page that nobody has connected a token for will 404 here rather than
 * serving an empty feed, and that is the honest answer: it is not "not crawled
 * yet", it is not collectable at all. See @rssamplifier/social's
 * facebook/canonical.js for why Facebook cannot work the way the other three do.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ page: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { page, format } = await params;
  const url = new URL(req.url);

  const target = facebookTarget({ page });
  if (!target) {
    return riverFail(
      format,
      400,
      `not a Facebook Page name: ${page}`,
      'Page names are 5-60 characters of A-Z, 0-9 and dot.',
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
