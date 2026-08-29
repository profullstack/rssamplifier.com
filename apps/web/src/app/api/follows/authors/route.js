import { accounts, authors } from '@rssamplifier/db';

import { db } from '../../../../lib/db.js';
import { currentUser } from '../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Follow or unfollow a person.
 *
 * The third sibling of /api/follows and /api/follows/topics, kept apart from
 * both for the reason the topics route already gives: they take different
 * identifiers, validate differently, and land somewhere different afterwards.
 *
 * What is different here is the indirection. The table is keyed on the author's
 * id, but the request carries their slug, because a slug is the public identity
 * and accepting an internal id would mean publishing one. So this resolves the
 * slug first, and that lookup is also where a follow on somebody who does not
 * exist is refused.
 *
 * Form-first like every other write on the site: a plain POST answered with a
 * 303 back to the page it came from, so following works with JavaScript off. A
 * JSON caller gets JSON.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  let rawSlug = '';
  let action = 'toggle';

  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await req.json();
      rawSlug = String(body?.slug ?? '');
      action = String(body?.action ?? 'toggle');
    } else {
      const form = await req.formData();
      rawSlug = String(form.get('slug') ?? '');
      action = String(form.get('action') ?? 'toggle');
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  // Lowercased the way `authorBySlug` expects and the way the page's own URL is
  // written, so a follow made from a link somebody typed in capitals is the
  // same row as one made from the page.
  const slug = rawSlug.trim().toLowerCase();
  if (!slug) return wantsHtml ? redirect('/authors') : json({ error: 'bad-request' }, 400);

  const page = `/authors/${encodeURIComponent(slug)}`;

  if (!user) {
    // Sent to sign in and then back to the person they were reading, rather
    // than handed a bare error.
    if (wantsHtml) return redirect(`/login?next=${encodeURIComponent(page)}`);
    return json({ error: 'sign-in-required' }, 401);
  }

  const client = db();
  const person = await authors.authorBySlug(client, slug);

  // Unlike the topic route, this refuses in both directions rather than only on
  // follow. A topic slug outlives the topic table by design, so an unfollow has
  // to work for a slug that no longer resolves; an author id only exists while
  // the author row does, and the cascade has already removed the follow by the
  // time the row is gone. There is nothing left to delete and nothing to key it
  // by, so a 404 is the honest answer.
  if (!person) return wantsHtml ? redirect('/authors') : json({ error: 'not-found' }, 404);

  const userId = String(user.id);
  const authorId = String(person.id);

  const following = await accounts.isFollowingAuthor(client, userId, authorId);
  const shouldFollow = action === 'follow' || (action === 'toggle' && !following);

  if (shouldFollow) await accounts.followAuthor(client, userId, authorId);
  else await accounts.unfollowAuthor(client, userId, authorId);

  if (wantsHtml) return redirect(page);
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
