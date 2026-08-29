import { riverFail } from '../../../../../../../lib/river.js';
import { socialRiver, xTarget } from '../../../../../../../lib/socialRiver.js';

export const dynamic = 'force-dynamic';

/**
 * An X list, by id. `/x/list/123456789.rss` rewrites here.
 *
 * Only the numeric id, never `/:owner/:slug` — resolving a list's slug to its
 * id means asking X, which is a request we would be making on behalf of an
 * anonymous caller who has not yet subscribed to anything. §29 leaves that
 * alias to a later phase for exactly that reason.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ listId: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { listId, format } = await params;
  const url = new URL(req.url);

  const target = xTarget({ listId });
  if (!target) {
    return riverFail(format, 400, `not an X list id: ${listId}`, 'A list id is 6-25 digits.');
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
