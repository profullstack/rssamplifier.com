import { hopResponse } from '../../../../lib/rings.js';

export const dynamic = 'force-dynamic';

/**
 * /ring/<slug>/random: 302 to an active member, never the one the reader is
 * on when there is anywhere else to go.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug } = await params;
  return hopResponse(req, { slug, kind: 'random' });
}
