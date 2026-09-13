import { hopResponse } from '../../../../lib/rings.js';

export const dynamic = 'force-dynamic';

/**
 * /ring/<slug>/next: 302 to the member after the one the reader came from.
 * Reasoning in lib/openwebring.js `hop`.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug } = await params;
  return hopResponse(req, { slug, kind: 'next' });
}
