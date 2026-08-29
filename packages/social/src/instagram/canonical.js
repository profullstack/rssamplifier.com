/**
 * Instagram, named the way Instagram names itself.
 *
 * The third platform through this door and the first one that cost almost
 * nothing, which is the point of having built the door. Instagram is X's shape
 * rather than Reddit's — it publishes no feeds, so posts are collected through a
 * provider and mirrored here — so this file is X's `canonical.js` with a
 * different set of URL rules, and everything downstream is already written.
 *
 * Two modes, not five. An account and a hashtag are the two things Instagram
 * exposes that behave like a feed; saved posts, stories and the explore tab are
 * either private, expiring, or personalised, and none of the three is a thing a
 * stranger can subscribe to.
 */

/** The two things worth subscribing to. */
export const INSTAGRAM_MODES = Object.freeze(['user', 'hashtag']);

/**
 * Instagram's rule for a handle: 1–30 of `[A-Za-z0-9._]`.
 *
 * Dots are legal here and are not legal on X, which is the one difference that
 * matters when this file is read next to `../x/canonical.js` — a handle regex
 * copied from there would silently reject a third of Instagram.
 */
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

/** A hashtag: letters, digits and underscore, no dots and no leading digit-only. */
const HASHTAG = /^[A-Za-z0-9_]{1,60}$/;

const HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'l.instagram.com',
  'instagr.am',
]);

/**
 * Path segments that are Instagram's own furniture rather than a handle.
 *
 * `explore` is the one that matters: `/explore/tags/coffee` is how a hashtag is
 * addressed, so reading the first segment as a username would create an account
 * called @explore that can never return a post.
 */
const NOT_A_HANDLE = new Set([
  'explore',
  'p',
  'reel',
  'reels',
  'tv',
  'stories',
  'direct',
  'accounts',
  'about',
  'developer',
  'legal',
  'privacy',
  'terms',
  'challenge',
]);

/**
 * Read whatever a person pasted and say which Instagram source they meant.
 *
 * @param {unknown} input
 * @returns {{ mode: 'user'|'hashtag', username?: string, tag?: string }|null}
 */
export function parseInstagramInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // `#coffee` — the shorthand for a hashtag, checked before anything else
  // because a `#` in a URL is a fragment and would be thrown away by a parse.
  const tag = /^#([A-Za-z0-9_]{1,60})$/.exec(raw);
  if (tag) return { mode: 'hashtag', tag: tag[1] };

  // `ig/somebody` — the explicit shorthand, and the one that matters for
  // submission. A *bare* `@somebody` is deliberately not routed here by
  // `socialSourceFrom`: it is ambiguous between X and Instagram, and X had it
  // first. This parser still accepts a bare handle because the `/ig/<handle>`
  // route calls it already knowing which platform it is holding.
  const short = /^\/?(?:ig|instagram)\/(@?[A-Za-z0-9._]{1,30})\/?$/i.exec(raw);
  if (short) {
    const name = short[1].replace(/^@/, '');
    return HANDLE.test(name) ? { mode: 'user', username: name } : null;
  }

  const bare = raw.replace(/^@/, '');
  if (HANDLE.test(bare) && !raw.includes('/') && !raw.includes(':')) {
    return { mode: 'user', username: bare };
  }

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

  const first = segments[0].toLowerCase();

  if (first === 'explore') {
    const name = segments[1]?.toLowerCase() === 'tags' ? segments[2] : null;
    return name && HASHTAG.test(name) ? { mode: 'hashtag', tag: name } : null;
  }

  // A single post or reel is something to look at, not a source to follow —
  // the same call `../x/canonical.js` makes about a status URL.
  if (NOT_A_HANDLE.has(first)) return null;
  if (!HANDLE.test(segments[0])) return null;

  // `/handle/reels`, `/handle/tagged` and friends are views of an account, and
  // none of them is separately collectable through the provider we use.
  if (segments[1]) return null;

  return { mode: 'user', username: segments[0] };
}

/**
 * @param {{ mode: string, username?: string, tag?: string }} spec
 * @returns {string|null}
 */
export function instagramRef(spec) {
  if (!spec) return null;
  if (spec.mode === 'user') return spec.username ? `ig:user:${spec.username.toLowerCase()}` : null;
  if (spec.mode === 'hashtag') return spec.tag ? `ig:tag:${spec.tag.toLowerCase()}` : null;
  return null;
}

/** The canonical address on Instagram's side. */
export function instagramUrl(spec) {
  if (!spec) return null;
  if (spec.mode === 'user') return `https://www.instagram.com/${spec.username}/`;
  if (spec.mode === 'hashtag') return `https://www.instagram.com/explore/tags/${spec.tag}/`;
  return null;
}

/** Where it lives on this site. */
export function instagramPath(spec) {
  if (!spec) return null;
  if (spec.mode === 'user') return `/ig/${spec.username}`;
  if (spec.mode === 'hashtag') return `/ig/tag/${spec.tag}`;
  return null;
}

/** A title for a source whose first crawl has not landed yet. */
export function instagramTitle(spec) {
  if (spec?.mode === 'user') return `@${spec.username} on Instagram`;
  if (spec?.mode === 'hashtag') return `#${spec.tag} on Instagram`;
  return 'Instagram';
}

/** The directory slug. */
export function instagramSlug(spec) {
  const ref = instagramRef(spec);
  if (!ref) return null;
  return ref
    .replace(/^ig:/, 'ig-')
    .replace(/:/g, '-')
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
export function instagramSource(input) {
  const spec = parseInstagramInput(input);
  if (!spec) return null;

  const ref = instagramRef(spec);
  const url = instagramUrl(spec);
  const path = instagramPath(spec);
  const slug = instagramSlug(spec);
  if (!ref || !url || !path || !slug) return null;

  return { ...spec, ref, url, path, slug, title: instagramTitle(spec) };
}

/**
 * Rebuild the spec from a stored ref, for the crawler.
 *
 * @param {unknown} ref
 * @returns {{ mode: 'user'|'hashtag', username?: string, tag?: string }|null}
 */
export function instagramSpecFromRef(ref) {
  const match = /^ig:(user|tag):(.+)$/.exec(String(ref ?? ''));
  if (!match) return null;

  const [, kind, rest] = match;
  if (kind === 'user') return HANDLE.test(rest) ? { mode: 'user', username: rest } : null;
  return HASHTAG.test(rest) ? { mode: 'hashtag', tag: rest } : null;
}
