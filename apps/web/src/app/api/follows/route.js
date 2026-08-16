import { accounts, q } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Follow or unfollow a blog.
 *
 * Takes a slug rather than a feed id: the slug is the blog's public identity
 * and the only handle a caller ever sees, so accepting an internal id would
 * mean publishing one.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  let slug = '';
  let action = 'toggle';

  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await req.json();
      slug = String(body?.slug ?? '');
      action = String(body?.action ?? 'toggle');
    } else {
      const form = await req.formData();
      slug = String(form.get('slug') ?? '');
      action = String(form.get('action') ?? 'toggle');
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  if (!user) {
    // A signed-out reader who clicked follow gets sent to sign in and then back
    // to the blog they were reading, rather than a bare error.
    if (wantsHtml) {
      return redirect(`/login?next=${encodeURIComponent(`/${slug}`)}`);
    }
    return json({ error: 'sign-in-required' }, 401);
  }

  const client = db();
  const feed = await q.feedBySlug(client, slug);
  if (!feed) return wantsHtml ? redirect('/') : json({ error: 'not-found' }, 404);

  const feedId = String(feed.id);
  const following = await accounts.isFollowing(client, String(user.id), feedId);

  const shouldFollow = action === 'follow' || (action === 'toggle' && !following);

  if (shouldFollow) await accounts.follow(client, String(user.id), feedId);
  else await accounts.unfollow(client, String(user.id), feedId);

  if (wantsHtml) return redirect(`/${slug}`);
  return json({ ok: true, slug, following: shouldFollow });
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
