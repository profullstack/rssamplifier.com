import { buildOpml } from '@rssamplifier/feed';

import { db } from '../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * The whole directory as an OPML subscription list.
 *
 * Load it into any feed reader, or hand it to an agent as a single artifact.
 */
export async function GET() {
  const sb = db();
  const { data } = await sb
    .from('feeds')
    .select('title, feed_url, site_url')
    .neq('status', 'dead')
    .order('title', { ascending: true })
    .limit(5000);

  return new Response(buildOpml(data ?? [], 'RSS Amplifier — full directory'), {
    headers: {
      'content-type': 'text/x-opml+xml; charset=utf-8',
      'content-disposition': 'inline; filename="rssamplifier.opml"',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=600',
    },
  });
}
