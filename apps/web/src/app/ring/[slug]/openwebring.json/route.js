import { siteUrl } from '../../../../lib/db.js';
import { loadRing } from '../../../../lib/rings.js';
import { ringFile } from '../../../../lib/openwebring.js';

export const dynamic = 'force-dynamic';

/**
 * /ring/<slug>/openwebring.json: the ring file, members in ring order.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug } = await params;
  const loaded = await loadRing(slug);

  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=300',
  };

  if (!loaded) {
    return new Response(JSON.stringify({ error: 'not-found', slug }, null, 2), { status: 404, headers });
  }

  const body = ringFile({ base: siteUrl(), ring: loaded.ring, members: loaded.members });
  return new Response(JSON.stringify(body, null, 2), { headers });
}
