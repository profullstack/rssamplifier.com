import { siteUrl } from '../../../../lib/db.js';
import { forgetRing, loadRing, ownsRing } from '../../../../lib/rings.js';
import { currentUser } from '../../../../lib/auth.js';
import { readRingForm } from '../../../../lib/ringForms.js';
import { webrings } from '@rssamplifier/db';
import { db } from '../../../../lib/db.js';
import { hopUrl, ringFile } from '../../../../lib/openwebring.js';
import { json } from '../../authors/route.js';

export const dynamic = 'force-dynamic';

/**
 * One ring, as JSON: the ring file plus where its pages are.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug } = await params;
  const loaded = await loadRing(slug);
  if (!loaded) return json({ error: 'not-found', slug }, 404);

  const base = siteUrl();
  const file = ringFile({ base, ring: loaded.ring, members: loaded.members });

  return json({
    ...file,
    members: file.members.map((m) => ({
      ...m,
      page: `${base}/${encodeURIComponent(String(m.slug))}`,
      next: hopUrl(base, loaded.ring.slug, 'next', String(m.url)),
      previous: hopUrl(base, loaded.ring.slug, 'previous', String(m.url)),
    })),
    active: loaded.ring.active_count,
    page: file.ring.url,
    opml: `${file.ring.url}/opml`,
    random: hopUrl(base, loaded.ring.slug, 'random'),
    join: `${file.ring.url}#join`,
  });
}

/**
 * Change a ring's title or description. The account that made it, only.
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

  const form = await readRingForm(req);
  if (!form || !form.title) return json({ error: 'title-required' }, 400);

  await webrings.updateRing(db(), loaded.ring.slug, { title: form.title, description: form.description });
  forgetRing(loaded.ring.slug);

  const page = `/ring/${encodeURIComponent(loaded.ring.slug)}`;
  if (wantsHtml) return Response.redirect(new URL(`${page}/edit?saved=1`, req.url), 303);
  return json({ ok: true, slug: loaded.ring.slug });
}
