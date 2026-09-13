import { hopResponse } from '../../../../lib/rings.js';

export const dynamic = 'force-dynamic';

/**
 * /ring/<slug>/prev: the alias for /previous, because half the rings ever
 * built spelled it this way and a member copying from one of them should
 * not get a 404 from us.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug } = await params;
  return hopResponse(req, { slug, kind: 'prev' });
}
