import { hopResponse } from '../../../../../lib/rings.js';

export const dynamic = 'force-dynamic';

/**
 * /ring/<slug>/<member>/next: the hop with the member named in the path,
 * the shape Hotline and the older IndieWeb rings used. No parameter and no
 * Referer needed.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string, member: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug, member } = await params;
  return hopResponse(req, { slug, memberSlug: member, kind: 'next' });
}
