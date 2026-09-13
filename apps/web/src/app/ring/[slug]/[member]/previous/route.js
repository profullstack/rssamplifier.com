import { hopResponse } from '../../../../../lib/rings.js';

export const dynamic = 'force-dynamic';

/**
 * /ring/<slug>/<member>/previous.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string, member: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug, member } = await params;
  return hopResponse(req, { slug, memberSlug: member, kind: 'previous' });
}
