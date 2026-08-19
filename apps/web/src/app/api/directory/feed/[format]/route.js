import { directoryRiver } from '../../../../../lib/directoryRiver.js';

export const dynamic = 'force-dynamic';

/**
 * The whole directory, newest first. `/feed.rss` rewrites here.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { format } = await params;
  const url = new URL(req.url);

  return directoryRiver({ format, limit: url.searchParams.get('limit') });
}
