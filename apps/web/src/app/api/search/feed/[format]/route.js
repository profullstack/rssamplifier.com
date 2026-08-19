import { searchRiver } from '../../../../../lib/searchRiver.js';

export const dynamic = 'force-dynamic';

/**
 * A search, as a feed. `/search.rss?q=lisp` rewrites here, query and all.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { format } = await params;
  const url = new URL(req.url);

  return searchRiver({
    query: url.searchParams.get('q'),
    kind: url.searchParams.get('kind'),
    format,
    limit: url.searchParams.get('limit'),
  });
}
