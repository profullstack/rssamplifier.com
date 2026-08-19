import { authorRiver } from '../../../../../../lib/authorRiver.js';

export const dynamic = 'force-dynamic';

/**
 * One author, as a feed. `/authors/ada-lovelace.rss` rewrites here.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug, format } = await params;
  const url = new URL(req.url);

  return authorRiver({ slug, format, limit: url.searchParams.get('limit') });
}
