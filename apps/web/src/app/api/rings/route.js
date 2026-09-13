import { webrings } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';
import { forgetRing } from '../../../lib/rings.js';
import { readRingForm, resolveMembers, ringSlugFor } from '../../../lib/ringForms.js';
import { SPEC, hostEntry } from '../../../lib/openwebring.js';
import { json } from '../authors/route.js';

export const dynamic = 'force-dynamic';

/**
 * The rings this site hosts, as JSON.
 *
 * The same entries as /.well-known/openwebring.json, with the page and the
 * API address of each ring added, and the active count beside the listed
 * count so a caller can see how much of a ring is live without fetching
 * every ring file.
 */
export async function GET() {
  const base = siteUrl();
  const rings = await webrings.listRings(db());

  return json({
    total: rings.length,
    host: `${base}/.well-known/openwebring.json`,
    spec: SPEC,
    rings: rings.map((ring) => ({
      ...hostEntry({ base, ring }),
      active: ring.active_count,
      kind: ring.kind,
      ...(ring.topic_slug ? { topic: `${base}/topics/${encodeURIComponent(ring.topic_slug)}` } : {}),
      api: `${base}/api/rings/${encodeURIComponent(ring.slug)}`,
    })),
  });
}

/**
 * Make a ring. Signed in; a title and at least one member that is in the
 * directory. Public as soon as the row exists: it is on the host file, in
 * the index and on the hops from this response on.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');
  const back = (/** @type {string} */ query) =>
    Response.redirect(new URL(`/ring/new${query}`, req.url), 303);

  const form = await readRingForm(req);
  if (!form) return wantsHtml ? back('?error=bad-request') : json({ error: 'bad-request' }, 400);

  if (!user) {
    if (wantsHtml) return Response.redirect(new URL('/login?next=%2Fring%2Fnew', req.url), 303);
    return json({ error: 'sign-in-required' }, 401);
  }
  if (!form.title) return wantsHtml ? back('?error=title') : json({ error: 'title-required' }, 400);

  const client = db();
  const { found, missing } = await resolveMembers(client, form.members);
  if (found.length === 0) {
    return wantsHtml
      ? back(`?error=members&missing=${encodeURIComponent(missing.join('\n'))}`)
      : json({ error: 'members-required', missing }, 400);
  }

  const slug = await ringSlugFor(client, form.title);
  const ring = await webrings.createRing(client, {
    slug,
    title: form.title,
    description: form.description,
    ownerId: String(user.id),
  });
  if (!ring) return wantsHtml ? back('?error=slug') : json({ error: 'slug-taken', slug }, 409);

  const added = await webrings.addRingMembers(client, slug, found);
  forgetRing(slug);

  const page = `/ring/${encodeURIComponent(slug)}`;
  if (wantsHtml) {
    return Response.redirect(
      new URL(missing.length ? `${page}/edit?missing=${encodeURIComponent(missing.join('\n'))}` : page, req.url),
      303,
    );
  }
  return json({ ok: true, slug, page: `${siteUrl()}${page}`, added, missing }, 201);
}
