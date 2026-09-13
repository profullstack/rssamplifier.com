import { webrings } from '@rssamplifier/db';

import { db } from '../../../../../lib/db.js';
import { currentUser } from '../../../../../lib/auth.js';
import { loadRing } from '../../../../../lib/rings.js';
import { json } from '../../../authors/route.js';

export const dynamic = 'force-dynamic';

/**
 * Like a ring, or take it back. `action` is like, unlike or toggle. On or
 * off per account; a like is a point for the reader and for the ring, an
 * unlike is nothing.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function POST(req, { params }) {
  const { slug } = await params;
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  let action = 'toggle';
  let next = '';
  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await req.json();
      action = String(body?.action ?? 'toggle');
      next = String(body?.next ?? '');
    } else {
      const form = await req.formData();
      action = String(form.get('action') ?? 'toggle');
      next = String(form.get('next') ?? '');
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  const loaded = await loadRing(slug);
  if (!loaded) return json({ error: 'not-found', slug }, 404);
  const page = `/ring/${encodeURIComponent(loaded.ring.slug)}`;
  const back = next.startsWith('/') ? next : page;

  if (!user) {
    if (wantsHtml) return Response.redirect(new URL(`/login?next=${encodeURIComponent(back)}`, req.url), 303);
    return json({ error: 'sign-in-required' }, 401);
  }

  const client = db();
  const userId = String(user.id);
  const was = await webrings.ringLiked(client, loaded.ring.slug, userId);
  const liked = action === 'like' || (action === 'toggle' && !was);
  await webrings.likeRing(client, loaded.ring.slug, userId, liked);
  if (liked && !was) {
    await webrings.recordRingEvent(client, { kind: 'like', ringSlug: loaded.ring.slug, userId }).catch(() => {});
  }
  const likes = await webrings.ringLikes(client, loaded.ring.slug);

  if (wantsHtml) return Response.redirect(new URL(back, req.url), 303);
  return json({ ok: true, slug: loaded.ring.slug, liked, likes });
}
