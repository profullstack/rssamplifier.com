/**
 * Reddit, named the way Reddit names itself.
 *
 * Unlike X, Reddit needs no provider and no session: every subreddit publishes
 * a real RSS document at `/r/<name>/.rss` and the ordinary crawler reads it.
 * So there is nothing to adapt here — only something to *address*.
 *
 * That is the whole point of this file. On 2026-08-29 a bulk import put 50,099
 * subreddits into the directory, 41% of the entire crawl queue, and every one
 * of them landed at a slug of its own alongside the blogs (`/programming`,
 * `/askhistorians`). Two things are wrong with that. A subreddit is not a blog
 * and a directory that files it as one is lying about its own contents; and
 * `r/programming` has an obvious address that people already know how to type,
 * which we were not serving.
 *
 * So `r:sub:programming` becomes the canonical identity, `/r/programming` the
 * canonical URL, and the feed's own `/{slug}` page keeps working and points at
 * it. Nothing is renamed and nothing is deleted: existing links survive, and
 * the new address is the one search engines are told about.
 *
 * See `../x/canonical.js` for the same job on a platform that publishes no
 * feeds at all — the two files share a shape on purpose.
 */

/** Reddit's rule for a subreddit name: 3–21 of `[A-Za-z0-9_]`. */
const SUBREDDIT = /^[A-Za-z0-9_]{3,21}$/;

/** And for a username: 3–20, plus `-`, which subreddits may not contain. */
const USERNAME = /^[A-Za-z0-9_-]{3,20}$/;

/** Every host that is Reddit, including the ones the crawler will have stored. */
const REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'i.reddit.com',
  'm.reddit.com',
  'amp.reddit.com',
]);

/**
 * Sort tabs, which are a view of a subreddit rather than a different one.
 *
 * `/r/programming/new/.rss` and `/r/programming/.rss` are the same community,
 * and treating them as two sources would poll Reddit twice for one thing. The
 * sort is dropped rather than preserved: a directory subscribes to a community,
 * not to an ordering of it.
 */
const SORTS = new Set(['new', 'hot', 'top', 'rising', 'controversial', 'best', 'gilded']);

/**
 * Read whatever a person pasted and say which Reddit source they meant.
 *
 * @param {unknown} input
 * @returns {{ mode: 'sub'|'user', name: string }|null}
 */
export function parseRedditInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // The shorthands people actually type, before anything tries to parse a URL:
  // `r/programming`, `/r/programming`, `u/spez`, `/u/spez`.
  const short = /^\/?(r|u|user)\/([A-Za-z0-9_-]{3,21})\/?$/i.exec(raw);
  if (short) {
    const name = short[2];
    if (short[1].toLowerCase() === 'r') {
      return SUBREDDIT.test(name) ? { mode: 'sub', name } : null;
    }
    return USERNAME.test(name) ? { mode: 'user', name } : null;
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (!REDDIT_HOSTS.has(url.hostname.toLowerCase())) return null;

  // `.rss`, `.json` and a trailing `/` are all spellings of the same path.
  const segments = url.pathname
    .replace(/\.(rss|json|xml)$/i, '')
    .split('/')
    .filter(Boolean);

  if (segments.length < 2) return null;

  const kind = segments[0].toLowerCase();
  const name = segments[1];

  if (kind === 'r') {
    if (!SUBREDDIT.test(name)) return null;
    // A third segment is either a sort we drop or a specific post we decline —
    // a permalink is something to read, not something to subscribe to.
    const tail = segments[2]?.toLowerCase();
    if (tail && !SORTS.has(tail)) return null;
    return { mode: 'sub', name };
  }

  if (kind === 'u' || kind === 'user') {
    return USERNAME.test(name) ? { mode: 'user', name } : null;
  }

  return null;
}

/**
 * Our key for the source. Case-folded, because Reddit's own URLs are
 * case-insensitive and `/r/Programming` and `/r/programming` are one community.
 *
 * @param {{ mode: string, name: string }} spec
 * @returns {string|null}
 */
export function redditRef(spec) {
  if (!spec?.name) return null;
  if (spec.mode === 'sub') return `r:sub:${spec.name.toLowerCase()}`;
  if (spec.mode === 'user') return `r:user:${spec.name.toLowerCase()}`;
  return null;
}

/**
 * The RSS document Reddit actually publishes — this one *is* fetched, unlike
 * an X source's canonical URL.
 *
 * `www.` rather than `old.` deliberately: the old host is a compatibility
 * shim Reddit has said it will retire, and a directory that pins 50,000 feeds
 * to it inherits that deadline.
 *
 * @param {{ mode: string, name: string }} spec
 * @returns {string|null}
 */
export function redditFeedUrl(spec) {
  if (!spec?.name) return null;
  if (spec.mode === 'sub') return `https://www.reddit.com/r/${spec.name}/.rss`;
  if (spec.mode === 'user') return `https://www.reddit.com/user/${spec.name}/.rss`;
  return null;
}

/** The human page on Reddit's side. */
export function redditSiteUrl(spec) {
  if (!spec?.name) return null;
  if (spec.mode === 'sub') return `https://www.reddit.com/r/${spec.name}/`;
  if (spec.mode === 'user') return `https://www.reddit.com/user/${spec.name}/`;
  return null;
}

/**
 * Where it lives on this site. A user goes under `/r/u/…` rather than `/u/…`
 * so that one prefix holds all of Reddit — which is the whole ask.
 *
 * @param {{ mode: string, name: string }} spec
 * @returns {string|null}
 */
export function redditPath(spec) {
  if (!spec?.name) return null;
  if (spec.mode === 'sub') return `/r/${spec.name}`;
  if (spec.mode === 'user') return `/r/u/${spec.name}`;
  return null;
}

/** A title for a source whose first crawl has not landed yet. */
export function redditTitle(spec) {
  if (spec?.mode === 'sub') return `r/${spec.name}`;
  if (spec?.mode === 'user') return `u/${spec.name} on Reddit`;
  return 'Reddit';
}

/** The directory slug, on the same rules as an X source's. */
export function redditSlug(spec) {
  const ref = redditRef(spec);
  if (!ref) return null;
  return ref
    .replace(/^r:sub:/, 'r-')
    .replace(/^r:user:/, 'r-u-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Everything a source row needs, from one pasted string.
 *
 * @param {unknown} input
 * @returns {{
 *   mode: string, name: string, ref: string, feedUrl: string, siteUrl: string,
 *   path: string, slug: string, title: string
 * }|null}
 */
export function redditSource(input) {
  const spec = parseRedditInput(input);
  if (!spec) return null;

  const ref = redditRef(spec);
  const feedUrl = redditFeedUrl(spec);
  const path = redditPath(spec);
  const slug = redditSlug(spec);
  if (!ref || !feedUrl || !path || !slug) return null;

  return {
    ...spec,
    ref,
    feedUrl,
    siteUrl: redditSiteUrl(spec),
    path,
    slug,
    title: redditTitle(spec),
  };
}

/**
 * Rebuild the spec from a stored ref.
 *
 * @param {unknown} ref
 * @returns {{ mode: 'sub'|'user', name: string }|null}
 */
export function redditSpecFromRef(ref) {
  const match = /^r:(sub|user):([A-Za-z0-9_-]{3,21})$/.exec(String(ref ?? ''));
  return match ? { mode: /** @type {'sub'|'user'} */ (match[1]), name: match[2] } : null;
}
