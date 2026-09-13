import { hopResponse } from '../../../../lib/rings.js';

export const dynamic = 'force-dynamic';

/**
 * /ring/<slug>/previous: 302 to the member before the one the reader came from.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug } = await params;
  return hopResponse(req, { slug, kind: 'previous' });
}
