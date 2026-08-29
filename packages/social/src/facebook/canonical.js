/**
 * Facebook — and the honest limits on what `/fb/` is worth.
 *
 * Read this before adding to it, because the shape of this file is decided by
 * something outside the codebase.
 *
 * **Facebook publishes nothing readable without a login.** Three doors,
 * measured rather than assumed on 2026-08-29:
 *
 *   - the old `facebook.com/feeds/page.php?format=rss20` endpoint answers 404;
 *     it was removed, not deprecated
 *   - `mbasic.facebook.com/<page>` answers 200 and redirects to `login.php`
 *   - RSSHub, which carries a thousand namespaces and maintains Twitter and
 *     Instagram, has no Facebook namespace at all
 *
 * So a Page is read the way X and Instagram are read: with a logged-in session,
 * off the HTML that mbasic renders server-side. That is `./scrape.js`, and it
 * is the default. `./fetch.js` will use Meta's Graph API instead for a Page
 * somebody administers and has a token for, because a supported API beats
 * guessing at markup — but a token is never required and almost never present.
 *
 * **What that third bullet is telling you.** RSSHub maintains Twitter and
 * Instagram and not this, and that is a verdict rather than an oversight:
 * Facebook is the most hostile of the three to being read this way. Expect the
 * markup to change, expect the reading account to be challenged, and expect
 * `/fb/` to be the least dependable namespace on the site. The failure handling
 * downstream is built for that — a checkpoint retires the *session*, never the
 * Page — but no amount of care makes the underlying surface stable.
 *
 * A personal profile is not readable by any of this. `profile.php` and friends
 * are rejected below rather than half-supported.
 */

/**
 * A Page's public name — the `/PageName` in a Facebook URL.
 *
 * Letters, digits and dots. Facebook documents a five-character minimum and
 * that minimum is wrong to enforce: it applies to usernames created now, and
 * plenty of long-standing Pages are shorter — facebook.com/NASA is four. A
 * regex written from the documentation rejects real Pages, so the floor is
 * three and `NOT_A_PAGE` below does the work of excluding furniture.
 */
const VANITY = /^[A-Za-z0-9.]{3,60}$/;

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
  const short = /^\/?(?:fb|facebook)\/([A-Za-z0-9.]{3,60})\/?$/i.exec(raw);
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
  const match = /^fb:page:([A-Za-z0-9.]{3,60}|[0-9]{6,25})$/.exec(String(ref ?? ''));
  return match ? { mode: 'page', page: match[1] } : null;
}
