import { buildOpml } from '@rssamplifier/feed';
import { q } from '@rssamplifier/db';

import { db } from '../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * The whole directory as an OPML subscription list.
 *
 * Load it into any feed reader, or hand it to an agent as a single artifact.
 */
export async function GET() {
  const rows = await q.allFeedsForExport(db(), 5000);

  const feeds = rows.map((r) => ({
    title: String(r.title ?? ''),
    feed_url: String(r.feed_url ?? ''),
    site_url: r.site_url ? String(r.site_url) : null,
  }));

  return new Response(buildOpml(feeds, 'RSS Amplifier — full directory'), {
    headers: {
      'content-type': 'text/x-opml+xml; charset=utf-8',
      'content-disposition': 'inline; filename="rssamplifier.opml"',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=600',
    },
  });
}
