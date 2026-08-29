import { feedRiver } from '../../../../../../lib/feedRiver.js';

export const dynamic = 'force-dynamic';

/**
 * One feed of the directory, as a feed of ours. `/phoenix-fm.rss` rewrites here.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug, format } = await params;
  const url = new URL(req.url);

  return feedRiver({
    slug,
    format,
    limit: url.searchParams.get('limit'),
    req,
  });
}
