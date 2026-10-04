import { webrings } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { hostFile } from '../../../lib/openwebring.js';

export const dynamic = 'force-dynamic';

/**
 * /.well-known/openwebring.json: the rings this site hosts.
 *
 * A route rather than a file in /public, because rings are data: which
 * topics have one and how many members each holds changes as the poller
 * seeds and verifies, and a file would say whatever it said on deploy day.
 * Five minutes of caching is the same allowance the JSON API gives itself.
 */
export async function GET() {
  const rings = await webrings.listRings(db());
  const body = {
    ...hostFile({ base: siteUrl(), siteName: 'RSS Amplifier', rings }),
    // The rings this site is itself a member of, beside the ones it hosts.
    made_by: 'both',
    rings: [{ ring: 'https://rssamplifier.com/ring/profullstack', slug: 'rssamplifier-com' }],
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}
