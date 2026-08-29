import { riverFail } from '../../../../../../lib/river.js';
import { facebookTarget, socialRiver } from '../../../../../../lib/socialRiver.js';

export const dynamic = 'force-dynamic';

/**
 * One Facebook Page, as a feed of ours. `/fb/SomePage.rss` rewrites here.
 *
 * A Page not in the directory 404s here rather than serving an empty feed, the
 * same as the other three namespaces. Facebook is read with a session against
 * mbasic; see @rssamplifier/social's facebook/scrape.js for how fragile that is
 * and where to fix it when it breaks.
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
      'Page names are 3-60 characters of A-Z, 0-9 and dot.',
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
