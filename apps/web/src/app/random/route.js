import { q } from '@rssamplifier/db';

import { db } from '../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Send the visitor to a random blog — the toolbar's ✦ button.
 *
 * An explicit 302 rather than Response.redirect() so the Location stays
 * relative and no origin has to be hard-coded.
 */
export async function GET() {
  const slug = await q.randomSlug(db());
  return new Response(null, {
    status: 302,
    headers: { location: slug ? `/${slug}` : '/', 'cache-control': 'no-store' },
  });
}
