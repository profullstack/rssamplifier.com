import { profiles } from '@rssamplifier/db';

import { db } from '../../../../../lib/db.js';
import { PROFILE_HEADERS, loadAuthorProfile } from '../../../../../lib/authorProfile.js';
import { overridesFromBody, overridesFromForm } from '../../../../../lib/openprofile.js';
import { callerOf, isOwner } from '../../../../../lib/profileAuth.js';
import { json } from '../../route.js';

export const dynamic = 'force-dynamic';

/** The most an edited profile may be: the file is a page, not a book. */
const BODY_LIMIT = 64 * 1024;

/**
 * The author's OpenProfile.md, read and written.
 *
 * GET answers the same Markdown as /authors/{slug}/openprofile.md, or the
 * parsed shape as JSON with `?format=json` (or an Accept for it), so an agent
 * that wants sections does not parse Markdown to get them.
 *
 * PUT is the owner correcting it. The body is either the whole file as
 * `text/markdown` (what a CLI hands back after $EDITOR) or a JSON patch
 * `{ name, headline, prose, identity: {Key: value|null}, sections: {name:
 * body|null}, public, markdown }`. Both store the same overlay
 * (@profullstack/openprofile), so a later GET renders what was sent, with the
 * sections the owner did not mention still generated. Write `none` (or null)
 * as a section to drop a generated one.
 *
 * POST is PUT for an HTML form: the edit page posts here and is sent back.
 *
 * Auth: the site's session, one of the account's API keys, or an OpenAccess
 * bearer with `openprofile:edit`. The caller must be the one who claimed the
 * profile (see ../claim).
 */

/**
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, ctx) {
  const { slug } = await ctx.params;
  const loaded = await loadAuthorProfile(slug.toLowerCase());
  if (!loaded || (loaded.profile && !loaded.profile.public)) return json({ error: 'not-found', slug }, 404);

  const url = new URL(req.url);
  const wantsJson =
    url.searchParams.get('format') === 'json' ||
    (req.headers.get('accept') ?? '').includes('application/json');

  if (!wantsJson) return new Response(loaded.markdown, { headers: PROFILE_HEADERS });

  return json({
    slug: String(loaded.person.slug),
    url: loaded.url,
    page: loaded.page,
    claimed: Boolean(loaded.profile?.claimed_at),
    public: loaded.profile?.public ?? true,
    updatedAt: loaded.profile?.updated_at ?? null,
    name: loaded.doc.name,
    identity: Object.fromEntries(loaded.doc.identity.map((e) => [e.key, e.value])),
    headline: loaded.doc.headline,
    sections: loaded.doc.sections.map((s) => ({ title: s.title, name: s.name, body: s.body })),
    markdown: loaded.markdown,
  });
}

/**
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function PUT(req, ctx) {
  const { slug } = await ctx.params;
  return write(req, slug.toLowerCase(), false);
}

/**
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function POST(req, ctx) {
  const { slug } = await ctx.params;
  return write(req, slug.toLowerCase(), true);
}

/**
 * @param {Request} req
 * @param {string} slug
 * @param {boolean} fromForm
 */
async function write(req, slug, fromForm) {
  const wantsHtml = fromForm && (req.headers.get('accept') ?? '').includes('text/html');
  const editPage = `/authors/${encodeURIComponent(slug)}/edit`;

  const loaded = await loadAuthorProfile(slug);
  if (!loaded) return wantsHtml ? redirect('/authors') : json({ error: 'not-found', slug }, 404);

  const caller = await callerOf(req);
  if (!caller.kind) {
    return wantsHtml
      ? redirect(`/login?next=${encodeURIComponent(editPage)}`)
      : json({ error: 'sign-in-required' }, 401);
  }
  if (!isOwner(caller, loaded.profile)) {
    const error = loaded.profile?.claimed_at
      ? 'not-the-owner'
      : `unclaimed: POST /api/authors/${slug}/claim first`;
    return wantsHtml ? redirect(`${editPage}?error=${encodeURIComponent(error)}`) : json({ error }, 403);
  }

  let next;
  if (fromForm && !(req.headers.get('content-type') ?? '').includes('json') && !/markdown|text\/plain/i.test(req.headers.get('content-type') ?? '')) {
    let form;
    try {
      form = await req.formData();
    } catch {
      return wantsHtml ? redirect(`${editPage}?error=bad-form`) : json({ error: 'bad-form' }, 400);
    }
    next = overridesFromForm(form);
  } else {
    const text = await req.text();
    if (text.length > BODY_LIMIT) return json({ error: `body over ${BODY_LIMIT} bytes` }, 413);
    next = overridesFromBody({
      contentType: req.headers.get('content-type') ?? '',
      text,
      existing: loaded.profile?.overrides ?? null,
      generated: loaded.generated,
    });
    if (next.error) return json({ error: next.error }, 400);
  }

  const saved = await profiles.saveProfile(db(), String(loaded.person.id), {
    overrides: next.overrides,
    ...(typeof next.public === 'boolean' ? { public: next.public } : {}),
  });

  if (wantsHtml) return redirect(`${editPage}?saved=1`);

  const after = await loadAuthorProfile(slug);
  return json({
    ok: true,
    slug,
    url: loaded.url,
    public: saved.public,
    updatedAt: saved.updated_at,
    markdown: after?.markdown ?? loaded.markdown,
  });
}

/**
 * @param {string} to
 * @returns {Response}
 */
function redirect(to) {
  return new Response(null, { status: 303, headers: { location: to } });
}
