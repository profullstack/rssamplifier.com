import { webrings } from '@rssamplifier/db';

import { db } from '../../../../../lib/db.js';
import { currentUser } from '../../../../../lib/auth.js';
import { forgetRing, loadRing, ownsRing } from '../../../../../lib/rings.js';
import { readRingForm, resolveMembers } from '../../../../../lib/ringForms.js';
import { json } from '../../../authors/route.js';

export const dynamic = 'force-dynamic';

/**
 * Add members to a ring you made (`action=add`, `members` one per line), or
 * take one out (`action=remove`, `member` the member's slug). New members go
 * on the end; nobody else's position moves.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function POST(req, { params }) {
  const { slug } = await params;
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');
  const loaded = await loadRing(slug);
  if (!loaded) return json({ error: 'not-found', slug }, 404);
  if (!user || !ownsRing(user, loaded.ring)) return json({ error: 'not-yours' }, user ? 403 : 401);

  /** @type {any} */
  let body;
  try {
    body = (req.headers.get('content-type') ?? '').includes('application/json')
      ? await req.clone().json()
      : Object.fromEntries((await req.clone().formData()).entries());
  } catch {
    return json({ error: 'bad-request' }, 400);
  }
  const action = String(body?.action ?? 'add');
  const client = db();
  const edit = `/ring/${encodeURIComponent(loaded.ring.slug)}/edit`;

  if (action === 'remove') {
    const member = String(body?.member ?? '');
    const gone = member ? await webrings.removeRingMember(client, loaded.ring.slug, member) : false;
    forgetRing(loaded.ring.slug);
    if (wantsHtml) return Response.redirect(new URL(edit, req.url), 303);
    return json({ ok: gone, slug: loaded.ring.slug, removed: gone ? member : null });
  }

  const form = await readRingForm(req);
  if (!form) return json({ error: 'bad-request' }, 400);
  const { found, missing } = await resolveMembers(client, form.members);
  const added = found.length ? await webrings.addRingMembers(client, loaded.ring.slug, found) : 0;
  forgetRing(loaded.ring.slug);

  if (wantsHtml) {
    const query = missing.length ? `?missing=${encodeURIComponent(missing.join('\n'))}` : '?saved=1';
    return Response.redirect(new URL(`${edit}${query}`, req.url), 303);
  }
  return json({ ok: true, slug: loaded.ring.slug, added, missing });
}
