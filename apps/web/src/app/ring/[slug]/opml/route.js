import { loadRing } from '../../../../lib/rings.js';
import { renderOpml } from '../../../../lib/openwebring.js';

export const dynamic = 'force-dynamic';

/**
 * /ring/<slug>/opml: the members' feeds as a subscription list.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug } = await params;
  const loaded = await loadRing(slug);
  if (!loaded) {
    return new Response('no such ring\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(renderOpml(loaded), {
    headers: {
      'content-type': 'text/x-opml+xml; charset=utf-8',
      'content-disposition': `inline; filename="rssamplifier-ring-${loaded.ring.slug}.opml"`,
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=600',
    },
  });
}
