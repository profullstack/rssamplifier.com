/**
 * Facebook — and the honest limits on what `/fb/` can ever be.
 *
 * Read this before adding to it, because the shape of this file is decided by
 * something outside the codebase.
 *
 * **There is no way to read an arbitrary public Facebook Page.** Three doors,
 * all measured rather than assumed, on 2026-08-29:
 *
 *   - the old `facebook.com/feeds/page.php?format=rss20` endpoint answers 404;
 *     it was removed, not deprecated
 *   - `mbasic.facebook.com/<page>` answers 200 with a login wall
 *   - RSSHub, which carries a thousand namespaces and maintains Twitter and
 *     Instagram, has no Facebook namespace at all
 *
 * The remaining door is the Graph API, and it only opens for Pages the caller
 * **administers**: reading somebody else's public Page needs the
 * `Page Public Content Access` feature, which requires App Review and business
 * verification and is granted rarely. So a Facebook source here is not
 * something a stranger can submit — it is something the Page's own operator
 * connects, by supplying a Page Access Token.
 *
 * That is a different bargain from the rest of this directory, where anyone may
 * submit anything, and `/fb/` should not pretend otherwise: a page nobody has
 * connected a token for is not "not crawled yet", it is "not collectable", and
 * the page says so.
 *
 * What is deliberately *not* here: anything that drives a logged-in Facebook
 * session against the login wall. It breaks constantly, it is against Meta's
 * terms, and it would put an account of ours at risk to serve a directory
 * nobody is paying for.
 */

/**
 * A Page's public name — the `/PageName` in a Facebook URL.
 *
 * Facebook calls it a "username" or "vanity URL" and permits letters, digits
 * and dots, minimum five characters.
 */
const VANITY = /^[A-Za-z0-9.]{5,60}$/;

/** A numeric Page id, which is what the Graph API actually addresses. */
const PAGE_ID = /^[0-9]{6,25}$/;

const HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'mbasic.facebook.com',
  'web.facebook.com',
  'fb.com',
  'www.fb.com',
]);

/**
 * Segments that are Facebook's own furniture rather than a Page name.
 *
 * `profile.php` is the important one: it is how every personal profile without
 * a vanity URL is addressed, and a personal profile is not collectable by any
 * means at all — there is no Graph API for somebody's own timeline.
 */
const NOT_A_PAGE = new Set([
  'profile.php',
  'people',
  'groups',
  'events',
  'marketplace',
  'watch',
  'gaming',
  'story.php',
  'photo.php',
  'permalink.php',
  'sharer',
  'sharer.php',
  'dialog',
  'login',
  'login.php',
  'help',
  'policies',
  'privacy',
  'terms',
  'settings',
  'pages',
  'pg',
]);

/**
 * Read whatever a person pasted and say which Page they meant.
 *
 * @param {unknown} input
 * @returns {{ mode: 'page', page: string }|null}
 */
export function parseFacebookInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // `fb/SomePage` and `fb.com/SomePage` shorthands, plus a bare numeric id.
  const short = /^\/?(?:fb|facebook)\/([A-Za-z0-9.]{5,60})\/?$/i.exec(raw);
  if (short) return { mode: 'page', page: short[1] };

  // A bare string of digits is deliberately NOT read as a Page id. It is also a
  // plausible X list id, and a directory that guesses which platform a bare
  // number belongs to will guess wrong in front of somebody eventually.

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const first = segments[0];
  const lower = first.toLowerCase();

  // `/pages/Some-Name/123456` — the old form, whose numeric id is the reliable
  // half and the only half the Graph API can use.
  if (lower === 'pages') {
    const id = segments.find((segment) => PAGE_ID.test(segment));
    return id ? { mode: 'page', page: id } : null;
  }

  if (NOT_A_PAGE.has(lower)) return null;

  // A post, a photo or a video under a Page is a thing to read, not a source.
  if (segments[1] && !['about', ''].includes(segments[1].toLowerCase())) return null;

  if (PAGE_ID.test(first)) return { mode: 'page', page: first };
  return VANITY.test(first) ? { mode: 'page', page: first } : null;
}

/**
 * @param {{ mode: string, page: string }} spec
 * @returns {string|null}
 */
export function facebookRef(spec) {
  if (!spec?.page) return null;
  return spec.mode === 'page' ? `fb:page:${spec.page.toLowerCase()}` : null;
}

/** The canonical address on Facebook's side. */
export function facebookUrl(spec) {
  return spec?.page ? `https://www.facebook.com/${spec.page}` : null;
}

/** Where it lives on this site. */
export function facebookPath(spec) {
  return spec?.page ? `/fb/${spec.page}` : null;
}

/** A title for a Page whose first collection has not happened yet. */
export function facebookTitle(spec) {
  return spec?.page ? `${spec.page} on Facebook` : 'Facebook';
}

/** The directory slug. */
export function facebookSlug(spec) {
  const ref = facebookRef(spec);
  if (!ref) return null;
  return ref
    .replace(/^fb:page:/, 'fb-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Everything a source row needs, from one pasted string.
 *
 * @param {unknown} input
 * @returns {object|null}
 */
export function facebookSource(input) {
  const spec = parseFacebookInput(input);
  if (!spec) return null;

  const ref = facebookRef(spec);
  const url = facebookUrl(spec);
  const path = facebookPath(spec);
  const slug = facebookSlug(spec);
  if (!ref || !url || !path || !slug) return null;

  return { ...spec, ref, url, path, slug, title: facebookTitle(spec) };
}

/**
 * Rebuild the spec from a stored ref.
 *
 * @param {unknown} ref
 * @returns {{ mode: 'page', page: string }|null}
 */
export function facebookSpecFromRef(ref) {
  const match = /^fb:page:([A-Za-z0-9.]{5,60}|[0-9]{6,25})$/.exec(String(ref ?? ''));
  return match ? { mode: 'page', page: match[1] } : null;
}
