import { webrings } from '@rssamplifier/db';

import { db } from '../../../../../../lib/db.js';
import { forgetRing, loadRing, profilesForFeed } from '../../../../../../lib/rings.js';
import { madeByPatch, memberEditVerdict, memberEntry } from '../../../../../../lib/openwebring.js';
import { adminEmails, callerOf } from '../../../../../../lib/profileAuth.js';
import { json } from '../../../../authors/route.js';

export const dynamic = 'force-dynamic';

/** The most a patch may be. Two fields; a page of them is somebody probing. */
const BODY_LIMIT = 4 * 1024;

/**
 * One member of a ring, read and corrected.
 *
 * GET is the member's entry from the ring file.
 *
 * PUT is the owner's word on who makes the site: `{ "made_by": "human" |
 * "ai" | "both" | null, "disclosure": "none" | "ai-assisted" | "ai-generated"
 * | "autonomous" | null }`. Recorded as the owner's (or an admin's), which a
 * later read of the site's own descriptor never overwrites. Auth: the site's
 * session, an API key, or an OpenAccess bearer; the caller must have claimed
 * the profile of one of the feed's authors, be an admin, or hold the
 * `openwebring:edit` scope.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string, member: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug, member } = await params;
  const loaded = await loadRing(slug);
  const row = loaded?.members.find((m) => m.member_slug === member.toLowerCase());
  if (!loaded || !row) return json({ error: 'not-found', ring: slug, member }, 404);
  return json({ ring: loaded.ring.slug, member: memberEntry(row) });
}

/**
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string, member: string }> }} ctx
 */
export async function PUT(req, { params }) {
  const { slug, member } = await params;
  const client = db();

  const ring = await webrings.ringBySlug(client, slug.toLowerCase());
  const row = ring ? await webrings.memberBySlug(client, ring.slug, member.toLowerCase()) : null;
  if (!ring || !row) return json({ error: 'not-found', ring: slug, member }, 404);

  const caller = await callerOf(req);
  const verdict = memberEditVerdict(caller, {
    profiles: await profilesForFeed(row.feed_id),
    admins: adminEmails(),
  });
  if (!verdict.ok) return json({ error: verdict.error }, verdict.status);

  const text = await req.text();
  if (text.length > BODY_LIMIT) return json({ error: `body over ${BODY_LIMIT} bytes` }, 413);
  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    return json({ error: 'bad-json' }, 400);
  }
  const patch = madeByPatch(body);
  if (!patch.ok) return json({ error: patch.error }, 400);

  const saved = await webrings.setMemberMadeBy(client, ring.slug, row.feed_id, {
    madeBy: patch.madeBy,
    disclosure: patch.disclosure,
    source: verdict.source,
  });
  forgetRing(ring.slug);

  return json({ ok: true, ring: ring.slug, source: verdict.source, member: memberEntry(saved ?? row) });
}
