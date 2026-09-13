import { authors, profiles } from '@rssamplifier/db';

import { db, siteUrl } from '../../../../../lib/db.js';
import { profileUrl } from '../../../../../lib/openprofile.js';
import { adminEmails, callerOf, claimVerdict, fetchPage } from '../../../../../lib/profileAuth.js';
import { json } from '../../route.js';

export const dynamic = 'force-dynamic';

/**
 * Claim an author's profile as your own.
 *
 * Verified automatically, one of two ways: the signed-in address is the one
 * the author published about themselves, or the author's own site links back
 * at this profile with rel="openprofile" or rel="me". Either proof is the
 * person vouching for the page from a place only they control, which is the
 * verification rule OpenProfile.md itself names. No form to fill in and
 * nobody to wait for; an admin can claim on somebody's behalf for the case
 * neither proof covers.
 *
 * Form-first like every write here: the author page posts a plain form and is
 * sent to the edit page; a JSON or bearer caller gets JSON.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function POST(req, ctx) {
  const { slug: raw } = await ctx.params;
  const slug = raw.toLowerCase();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');
  const page = `/authors/${encodeURIComponent(slug)}`;

  const client = db();
  const person = await authors.authorBySlug(client, slug);
  if (!person) return wantsHtml ? redirect('/authors') : json({ error: 'not-found', slug }, 404);

  const caller = await callerOf(req);
  if (!caller.kind) {
    return wantsHtml ? redirect(`/login?next=${encodeURIComponent(page)}`) : json({ error: 'sign-in-required' }, 401);
  }

  const profile = await profiles.profileForAuthor(client, String(person.id));
  const base = siteUrl();
  const verdict = await claimVerdict({
    caller,
    person,
    profile,
    profileUrl: profileUrl(base, slug),
    pageUrl: `${base}${page}`,
    admins: adminEmails(),
    fetchText: fetchPage,
  });

  if (!verdict.ok) {
    return wantsHtml
      ? redirect(`${page}?claim=${encodeURIComponent(verdict.error)}`)
      : json({ error: verdict.error }, verdict.status);
  }

  const claimed = await profiles.claimProfile(client, String(person.id), {
    userId: caller.userId,
    principal: caller.principal,
    method: verdict.method,
  });

  if (wantsHtml) return redirect(`${page}/edit?claimed=1`);

  return json({
    ok: true,
    slug,
    method: verdict.method,
    claimedAt: claimed.claimed_at,
    url: profileUrl(base, slug),
    edit: `${base}/api/authors/${encodeURIComponent(slug)}/openprofile`,
  });
}

/**
 * @param {string} to
 * @returns {Response}
 */
function redirect(to) {
  return new Response(null, { status: 303, headers: { location: to } });
}
