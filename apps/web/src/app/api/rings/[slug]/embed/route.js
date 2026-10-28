import { embedResponse, ringsParam } from '../../../../../lib/ringEmbedRoute.js';

export const dynamic = 'force-dynamic';

/**
 * The copy-paste footer row for this ring (`<< Ring >>`), with hops measured
 * from `?site=`. `?also=b,c` stacks more rings under it. See
 * lib/ringEmbedRoute.js for the parameters.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug } = await params;
  const url = new URL(req.url);
  const also = url.searchParams.getAll('also').join(',');
  const extra = also ? ringsParam(new URL(`https://x/?rings=${encodeURIComponent(also)}`)) : [];
  return embedResponse(req, [...new Set([slug.toLowerCase(), ...extra])]);
}
