import { alerts, authors, q } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';
import { slugFromUrl } from '../../../lib/topicGroups.js';

export const dynamic = 'force-dynamic';

/**
 * Whether one follow is worth being interrupted about.
 *
 * A flag on something already followed, not a subscription of its own — so this
 * refuses rather than creates when there is no follow to flag. The two are one
 * gesture in the UI and it would be tempting to fold them together here, but a
 * request that silently followed something on the way to alerting on it would
 * make the bell a second follow button, which is not what it says.
 *
 * Takes the same slug the follow endpoints do, for the same reason: a slug is
 * the public identity, and accepting an internal id would mean publishing one.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  let kind = 'feed';
  let slug = '';
  let segment = '';
  let on = true;
  let next = '';

  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await req.json();
      kind = String(body?.kind ?? 'feed');
      slug = String(body?.slug ?? '');
      segment = String(body?.segment ?? '');
      // A JSON caller sends a boolean; a form sends '1'. Both mean the same
      // thing and neither should have to know about the other's spelling.
      on = body?.alerts === true || body?.alerts === '1';
      next = String(body?.next ?? '');
    } else {
      const form = await req.formData();
      kind = String(form.get('kind') ?? 'feed');
      slug = String(form.get('slug') ?? '');
      segment = String(form.get('segment') ?? '');
      on = String(form.get('alerts') ?? '') === '1';
      next = String(form.get('next') ?? '');
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  if (kind !== 'feed' && kind !== 'topic' && kind !== 'author') {
    return json({ error: 'bad-kind' }, 400);
  }

  // Only ever back to somewhere on this site. `next` arrives in a form field, so
  // an absolute URL in it would make this endpoint an open redirect.
  const back = next.startsWith('/') && !next.startsWith('//') ? next : fallbackPath(kind, slug, segment);

  if (!user) {
    if (wantsHtml) return redirect(`/login?next=${encodeURIComponent(back)}`);
    return json({ error: 'sign-in-required' }, 401);
  }

  const client = db();
  const userId = String(user.id);

  const changed =
    kind === 'feed'
      ? await setForFeed(client, userId, slug, on)
      : kind === 'author'
        ? await setForAuthor(client, userId, slug, on)
        : await alerts.setTopicAlerts(client, userId, slugFromUrl(slug), segment, on);

  // Not following it — or, for a blog, no such blog. Either way there is nothing
  // to flag, and saying so is more useful than reporting a success that did not
  // happen.
  if (!changed) {
    if (wantsHtml) return redirect(back);
    return json({ error: 'not-following' }, 409);
  }

  if (wantsHtml) return redirect(back);
  return json({ ok: true, kind, slug, segment, alerts: on });
}

/**
 * Resolve a blog's slug to its id, then flag the follow.
 *
 * @param {import('@libsql/client').Client} client
 * @param {string} userId
 * @param {string} slug
 * @param {boolean} on
 * @returns {Promise<boolean>}
 */
async function setForFeed(client, userId, slug, on) {
  const feed = await q.feedBySlug(client, slug);
  if (!feed) return false;
  return alerts.setFeedAlerts(client, userId, String(feed.id), on);
}

/**
 * Resolve a person's slug to their id, then flag the follow.
 *
 * The same indirection as the blog above and for the same reason: the table is
 * keyed on an id the reader never sees, and the slug is what a page can send.
 *
 * @param {import('@libsql/client').Client} client
 * @param {string} userId
 * @param {string} slug
 * @param {boolean} on
 * @returns {Promise<boolean>}
 */
async function setForAuthor(client, userId, slug, on) {
  const person = await authors.authorBySlug(client, String(slug).trim().toLowerCase());
  if (!person) return false;
  return alerts.setAuthorAlerts(client, userId, String(person.id), on);
}

/**
 * Where a no-JavaScript submit lands when the form did not say.
 *
 * @param {string} kind
 * @param {string} slug
 * @param {string} segment
 * @returns {string}
 */
function fallbackPath(kind, slug, segment) {
  if (kind === 'author') return `/authors/${encodeURIComponent(String(slug).toLowerCase())}`;
  if (kind !== 'topic') return `/${slug}`;
  const base = `/topics/${encodeURIComponent(slugFromUrl(slug))}`;
  return segment ? `${base}/${encodeURIComponent(segment)}` : base;
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
