import { webrings } from '@rssamplifier/db';

import { db } from '../../../../../lib/db.js';
import { currentUser } from '../../../../../lib/auth.js';
import { loadRing } from '../../../../../lib/rings.js';

export const dynamic = 'force-dynamic';

/**
 * Somebody shared this ring: the share button reports it here after the
 * share sheet or the clipboard took the link. Signed in, it is a point for
 * the reader too; signed out, it is a point for the ring alone. Always 204,
 * because a beacon has nobody to tell.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function POST(req, { params }) {
  const { slug } = await params;
  const [loaded, user] = await Promise.all([loadRing(slug), currentUser()]);
  if (loaded) {
    let member = null;
    try {
      const body = (req.headers.get('content-type') ?? '').includes('application/json') ? await req.json() : null;
      member = body?.member ? String(body.member).slice(0, 200) : null;
    } catch {
      member = null;
    }
    await webrings
      .recordRingEvent(db(), {
        kind: 'share',
        ringSlug: loaded.ring.slug,
        memberSlug: member,
        userId: user ? String(user.id) : null,
      })
      .catch(() => {});
  }
  return new Response(null, { status: 204 });
}
