import { directoryRiver } from '../../../../../../lib/directoryRiver.js';

export const dynamic = 'force-dynamic';

/**
 * One category of the directory, newest first. `/podcasts.rss` rewrites here.
 *
 * The category arrives as a path segment rather than `?kind=`, and that is not
 * a style choice: a rewrite's destination query string never reaches an App
 * Router handler — `req.url` here is the URL the client asked for, not the one
 * the rewrite produced — so every category feed would quietly serve the whole
 * directory. Same reason the topic feeds put their group in the path.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ kind: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { kind, format } = await params;
  const url = new URL(req.url);

  return directoryRiver({ kind, format, limit: url.searchParams.get('limit') });
}
