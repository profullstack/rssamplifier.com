import { riverFail } from '../../../../../../../lib/river.js';
import { socialRiver, xTarget } from '../../../../../../../lib/socialRiver.js';

export const dynamic = 'force-dynamic';

/** The two tabs of an account that are feeds in their own right (§25, §7). */
const MODES = new Set(['replies', 'media']);

/**
 * `/x/OpenAI/replies.rss` and `/x/OpenAI/media.rss`.
 *
 * A different source rather than a filter on the timeline: each has its own
 * canonical ref and therefore its own row, which is what lets a reader
 * subscribe to an account's posts and its replies at the same time without
 * either one having to carry the other's items.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ username: string, mode: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { username, mode, format } = await params;
  const url = new URL(req.url);

  if (!MODES.has(mode)) {
    return riverFail(format, 404, `no such X feed: ${mode}`, 'Try /replies or /media.');
  }

  const target = xTarget({ username, mode });
  if (!target) {
    return riverFail(
      format,
      400,
      `not an X handle: ${username}`,
      'Handles are 1-15 characters of A-Z, 0-9 and underscore.',
    );
  }

  return socialRiver({
    ref: target.ref,
    canonical: target.canonical,
    label: target.label,
    format,
    limit: url.searchParams.get('limit'),
    req,
  });
}
