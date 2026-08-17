import { accounts, q } from '@rssamplifier/db';

import { db } from '../../../../lib/db.js';
import { currentUser } from '../../../../lib/auth.js';
import { slugFromUrl, topicGroup } from '../../../../lib/topicGroups.js';

export const dynamic = 'force-dynamic';

/**
 * Follow or unfollow a topic — or one category of a topic.
 *
 * The sibling of /api/follows, which does the same for a blog. Kept apart rather
 * than switched on inside it: the two take different identifiers, validate
 * differently and redirect somewhere different, and the only thing they would
 * actually share is the plumbing below.
 *
 * Form-first, like every other write on the site: a plain POST from a page,
 * answered with a 303 back to the page it came from, so following works with
 * JavaScript off. A JSON caller gets JSON.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  let rawSlug = '';
  let rawSegment = '';
  let action = 'toggle';

  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await req.json();
      rawSlug = String(body?.slug ?? '');
      rawSegment = String(body?.segment ?? '');
      action = String(body?.action ?? 'toggle');
    } else {
      const form = await req.formData();
      rawSlug = String(form.get('slug') ?? '');
      rawSegment = String(form.get('segment') ?? '');
      action = String(form.get('action') ?? 'toggle');
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  // Normalised the same way every route that takes a keyword normalises it, so a
  // follow made from /topics/Home%20Lab is the same row as one made from
  // /topics/home-lab.
  const slug = slugFromUrl(rawSlug);
  if (!slug) return wantsHtml ? redirect('/topics') : json({ error: 'bad-request' }, 400);

  // A sub-group nobody recognises is refused rather than quietly widened to the
  // whole topic: the caller asked to follow the podcasts and would otherwise be
  // signed up to everything, which is the kind of surprise a reader discovers
  // only once their river fills with the wrong thing.
  const group = rawSegment ? topicGroup(rawSegment) : null;
  if (rawSegment && !group) {
    return wantsHtml
      ? redirect(`/topics/${encodeURIComponent(slug)}`)
      : json({ error: 'unknown-group' }, 400);
  }

  const segment = group?.segment ?? '';
  const page = `/topics/${encodeURIComponent(slug)}${segment ? `/${segment}` : ''}`;

  if (!user) {
    // Sent to sign in and then back to the topic they were reading, rather than
    // handed a bare error.
    if (wantsHtml) return redirect(`/login?next=${encodeURIComponent(page)}`);
    return json({ error: 'sign-in-required' }, 401);
  }

  const client = db();

  // A topic nobody covers has no page, so a follow on it would sit in the table
  // producing nothing forever. Checked on follow only: unfollowing a slug that
  // has since gone quiet has to keep working, or the row can never be removed.
  const topic = await q.topicBySlug(client, slug);
  const known = Boolean(topic);

  const userId = String(user.id);
  const following = await accounts.isFollowingTopic(client, userId, slug, segment);
  const shouldFollow = action === 'follow' || (action === 'toggle' && !following);

  if (shouldFollow && !known) {
    return wantsHtml ? redirect('/topics') : json({ error: 'not-found' }, 404);
  }

  if (shouldFollow) await accounts.followTopic(client, userId, slug, segment);
  else await accounts.unfollowTopic(client, userId, slug, segment);

  if (wantsHtml) return redirect(page);
  return json({ ok: true, slug, segment: segment || null, following: shouldFollow });
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
