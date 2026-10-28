import { embedResponse, ringsParam } from '../../../../../lib/ringEmbedRoute.js';

export const dynamic = 'force-dynamic';

/**
 * The copy-paste footer rows for several rings at once:
 * `/api/v1/rings/embed?rings=a,b&site=https://your.site/`. One row per ring,
 * in the order given. See lib/ringEmbedRoute.js for the other parameters.
 *
 * @param {Request} req
 */
export async function GET(req) {
  return embedResponse(req, ringsParam(new URL(req.url)));
}
