import { q, reactions } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/** Actions this endpoint accepts, and what each one sets. */
const ACTIONS = new Set(['like', 'unlike', 'up', 'down', 'clear']);

/**
 * Like a post, or vote on it.
 *
 * Addressed by slug and guid rather than by the internal item id, for the same
 * reason the reader is: those two are the only handles the site publishes, and
 * accepting an id would mean publishing one.
 *
 * Like and vote are different verbs deliberately. A like is private and goes to
 * the reader's own /favorites; a vote is public and moves a score everybody
 * sees. Conflating them would mean a reader cannot save something without
 * endorsing it.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  let slug = '';
  let guid = '';
  let action = '';

  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await req.json();
      slug = String(body?.slug ?? '');
      guid = String(body?.guid ?? '');
      action = String(body?.action ?? '');
    } else {
      const form = await req.formData();
      slug = String(form.get('slug') ?? '');
      guid = String(form.get('guid') ?? '');
      action = String(form.get('action') ?? '');
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  if (!ACTIONS.has(action)) return json({ error: 'bad-action' }, 400);

  const back = `/${slug}/read?p=${encodeURIComponent(guid)}`;

  if (!user) {
    // Send them to sign in and back to the post they were reading, rather than
    // dropping the click on the floor.
    if (wantsHtml) return redirect(`/login?next=${encodeURIComponent(back)}`);
    return json({ error: 'sign-in-required' }, 401);
  }

  const client = db();
  const feed = await q.feedBySlug(client, slug);
  if (!feed) return wantsHtml ? redirect('/') : json({ error: 'not-found' }, 404);

  const item = await q.itemByGuid(client, String(feed.id), guid);
  if (!item) return wantsHtml ? redirect(`/${slug}`) : json({ error: 'not-found' }, 404);

  const itemId = String(item.id);
  const userId = String(user.id);

  if (action === 'like' || action === 'unlike') {
    await reactions.setLike(client, userId, itemId, action === 'like');
  } else {
    // An identical vote clicked twice means "undo", the way every voting
    // control on the web behaves; without it the only way back to neutral
    // would be a third button.
    const current = await reactions.reactionFor(client, userId, itemId);
    const wanted = action === 'up' ? 1 : action === 'down' ? -1 : 0;
    const next = current.vote === wanted ? 0 : wanted;
    await reactions.setVote(client, userId, itemId, /** @type {-1|0|1} */ (next));
  }

  if (wantsHtml) return redirect(back);

  const [state, score] = await Promise.all([
    reactions.reactionFor(client, userId, itemId),
    reactions.scoreFor(client, itemId),
  ]);

  return json({ ok: true, slug, guid, ...state, ...score });
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
