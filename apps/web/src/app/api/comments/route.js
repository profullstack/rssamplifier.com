import { q, reactions } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Comment on a post, or withdraw one's own comment.
 *
 * The thread belongs to the post as the directory knows it, not to the blog:
 * we are commenting in a reader, on somebody else's article, and nothing here
 * is sent to their site.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  let slug = '';
  let guid = '';
  let body = '';
  let action = 'add';
  let id = '';

  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const payload = await req.json();
      slug = String(payload?.slug ?? '');
      guid = String(payload?.guid ?? '');
      body = String(payload?.body ?? '');
      action = String(payload?.action ?? 'add');
      id = String(payload?.id ?? '');
    } else {
      const form = await req.formData();
      slug = String(form.get('slug') ?? '');
      guid = String(form.get('guid') ?? '');
      body = String(form.get('body') ?? '');
      action = String(form.get('action') ?? 'add');
      id = String(form.get('id') ?? '');
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  const back = `/${slug}/read?p=${encodeURIComponent(guid)}`;

  if (!user) {
    if (wantsHtml) return redirect(`/login?next=${encodeURIComponent(back)}`);
    return json({ error: 'sign-in-required' }, 401);
  }

  const client = db();
  const userId = String(user.id);

  if (action === 'delete') {
    // Scoped to the author inside the statement, so an id lifted from the page
    // cannot delete anybody else's comment.
    const removed = await reactions.deleteComment(client, id, userId);
    if (wantsHtml) return redirect(back);
    return json({ ok: removed });
  }

  const feed = await q.feedBySlug(client, slug);
  if (!feed) return wantsHtml ? redirect('/') : json({ error: 'not-found' }, 404);

  const item = await q.itemByGuid(client, String(feed.id), guid);
  if (!item) return wantsHtml ? redirect(`/${slug}`) : json({ error: 'not-found' }, 404);

  const commentId = await reactions.addComment(client, String(item.id), userId, body);
  if (!commentId) {
    // An empty comment is a slip, not an error worth a page: put them back on
    // the post with the box still there.
    if (wantsHtml) return redirect(back);
    return json({ error: 'empty' }, 400);
  }

  if (wantsHtml) return redirect(`${back}#comment-${commentId}`);
  return json({ ok: true, id: commentId });
}

/**
 * @param {string} location
 * @returns {Response}
 */
function redirect(location) {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
