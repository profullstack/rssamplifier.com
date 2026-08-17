/**
 * Slugs are the public identity of a blog on the directory: /<blog-title>/.
 * They have to survive being typed by a human, pasted by an agent and used as a
 * primary lookup key, so they stay lowercase, ASCII and free of consecutive
 * separators.
 */

const RESERVED = new Set([
  'api',
  'submit',
  'search',
  'opml',
  'llms.txt',
  'robots.txt',
  'sitemap.xml',
  'about',
  'feeds',
  'blog',
  // The category pages. A feed slugged 'podcasts' would not break the site —
  // Next serves the static segment ahead of [slug] — but its own page would be
  // unreachable, which is worse for the blog than a -2 suffix.
  'blogs',
  'news',
  'podcasts',
  'music',
  'videos',
  'comics',
  'lives',
  'reels',
  'topics',
  // The people index, for the same reason as the categories above: a feed
  // slugged 'authors' would still be served, but only Next's static segment
  // would answer and the blog's own page would be unreachable.
  'authors',
  'admin',
  'static',
  '_next',
  'favicon.ico',
]);

/**
 * Turn arbitrary text into a URL-safe slug.
 *
 * @param {string} input
 * @returns {string} slug, or '' when the input has no usable characters
 */
export function slugify(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFKD')
    // strip combining marks so "Café" becomes "cafe" rather than "caf"
    .replace(/[\u0300-\u036f]/g, '')
    // Put every other mark back on the character it belongs to. NFKD also splits
    // the Japanese dakuten off its kana — ブ decomposes to フ + U+3099 — and that
    // mark is not a letter, so leaving it separated turns ブログ into フ-ク.
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’]/g, '')
    // Unicode letters and digits are kept, not stripped to a-z. A directory of
    // the small web is not all Latin script: an a-z filter turns every Cyrillic,
    // Greek, Hebrew, Arabic or CJK title into an empty slug, and the hostname
    // fallback then names them all after their host — which for a list of 258
    // YouTube channels means youtube-com, youtube-com-2, youtube-com-3.
    // Combining marks were already folded away above, so Latin titles are
    // unchanged: "Café" is still "cafe".
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/**
 * A slug is reserved when it would shadow one of the site's own routes.
 *
 * @param {string} slug
 * @returns {boolean}
 */
export function isReserved(slug) {
  return RESERVED.has(slug);
}

/**
 * Pick a slug that is neither reserved nor already taken.
 *
 * Falls back to the feed's hostname when the title yields nothing usable (a
 * title of "!!!" or a feed with no title at all), then appends -2, -3 … until
 * it finds a free one. `taken` is consulted rather than mutated so the caller
 * decides when a slug is really claimed.
 *
 * @param {string} title
 * @param {string} [fallbackUrl] used when the title produces an empty slug
 * @param {(slug: string) => boolean} [taken] returns true if already in use
 * @returns {string}
 */
export function uniqueSlug(title, fallbackUrl = '', taken = () => false) {
  let base = slugify(title);

  if (!base && fallbackUrl) {
    try {
      base = slugify(new URL(fallbackUrl).hostname.replace(/^www\./, ''));
    } catch {
      base = '';
    }
  }
  if (!base) base = 'feed';

  let candidate = base;
  let n = 1;
  while (isReserved(candidate) || taken(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}
