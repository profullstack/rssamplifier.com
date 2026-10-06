import { redditPostId, redditSource } from '@rssamplifier/social';

import { loadRedditThread } from '../../../../../../lib/redditThread.js';

export const dynamic = 'force-dynamic';

/**
 * One Reddit thread as JSON: the post and its comment tree.
 *
 * `/r/<sub>/comments/<id>.json` and `/r/<sub>/comments/<id>/<slug>.json`
 * rewrite here, the same `.json` suffix Reddit itself answers to, so a script
 * written against Reddit's spelling works by changing the host.
 *
 * @param {Request} _req
 * @param {{ params: Promise<{ subreddit: string, id: string }> }} ctx
 */
export async function GET(_req, { params }) {
  const { subreddit, id } = await params;
  if (!redditSource(`r/${subreddit}`) || !redditPostId(id)) {
    return Response.json({ error: 'not a reddit thread address' }, { status: 400 });
  }

  let thread;
  try {
    thread = await loadRedditThread(subreddit, id);
  } catch (error) {
    return Response.json(
      { error: 'the reddit archive did not answer', detail: String(error?.message ?? error).slice(0, 200) },
      { status: 502, headers: { 'retry-after': '60' } },
    );
  }

  if (!thread) return Response.json({ error: 'no such thread in the archive' }, { status: 404 });
  if (thread.moved) {
    return Response.json(
      { error: 'that thread is in another subreddit', subreddit: thread.moved.subreddit, id: thread.moved.id },
      { status: 404 },
    );
  }

  return Response.json(
    { post: thread.post, comments: thread.comments, source: 'arctic-shift' },
    { headers: { 'cache-control': 'public, max-age=60' } },
  );
}
