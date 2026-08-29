/**
 * What an X source *is*, before anybody has fetched anything.
 *
 * Every other source in this directory has an identity handed to it: a feed's
 * identity is the URL its document lives at, and two submissions of the same
 * URL collide on `feeds.feed_url` without anyone having to think about it. X
 * has no such document, so the identity has to be constructed — and constructed
 * the same way every time, or a thousand readers subscribing to @OpenAI become
 * a thousand separate polling jobs against a platform that rate-limits per
 * account (see §37/§38 of the PRD, and `markHostThrottled` in queries.js for
 * what that costs when it goes wrong on a smaller platform).
 *
 * So this module is the whole of the answer to "are these two requests the same
 * source?", and it is deliberately the only place that decides. It produces
 * two strings per source:
 *
 * - a **ref** (`x:user:openai`) — our own key, lowercase and free of anything a
 *   URL parser could disagree about. This is what the unique index is on.
 * - a **URL** (`https://x.com/OpenAI`) — the canonical public address of the
 *   thing on X's side. It goes in `feeds.feed_url` because that column is
 *   `not null unique` and every surface in this codebase expects a feed to have
 *   an http(s) address it could show a human. Nothing ever fetches it: the
 *   crawler routes an X source to a provider instead. It is an identifier that
 *   happens to also be a working link, which is the best kind.
 *
 * The display casing is preserved separately (`username`), because @OpenAI is
 * how the account writes its own name and lowercasing it in the page title
 * would be us correcting a publisher's spelling of themselves.
 */

/** The five things a reader can point us at. Mirrors `XFeedMode` in the PRD. */
export const X_MODES = Object.freeze(['user', 'replies', 'media', 'search', 'list']);

/**
 * X's own rule for a handle: 1–15 of `[A-Za-z0-9_]`.
 *
 * Worth pinning rather than accepting anything short, because this string is
 * interpolated into an upstream provider's path. A handle that cannot contain a
 * slash or a dot cannot walk out of the route it was put in.
 */
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** A list id is a snowflake: digits, and long enough not to be a typo. */
const LIST_ID = /^[0-9]{6,25}$/;

/**
 * Hosts that mean X. `twitter.com` is not a legacy alias to be tidied away —
 * it is still what most links in the wild say, and what most people paste.
 */
const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'm.twitter.com',
  'nitter.net',
]);

/**
 * Path segments that are X's own furniture rather than somebody's handle.
 *
 * `https://x.com/search?q=…` and `https://x.com/i/lists/123` are real addresses
 * whose first segment looks exactly like a username, and reading them as one
 * would create a source called @search that can never return a post. The list
 * is short on purpose: it names the paths this module actually routes plus the
 * few reserved words that would otherwise be silently accepted as accounts.
 */
const NOT_A_HANDLE = new Set([
  'i',
  'search',
  // Ours rather than X's. `/x/list/…` and `/x/status` are fixed segments on
  // this site, so an account genuinely named @list or @status could be stored
  // and then never addressed — a row nothing can reach. Refusing it up front is
  // the smaller loss, and it is two handles.
  'list',
  'status',
  'home',
  'explore',
  'notifications',
  'messages',
  'settings',
  'compose',
  'intent',
  'hashtag',
  'login',
  'signup',
  'about',
  'tos',
  'privacy',
]);

/**
 * Read whatever a person pasted and say which X source they meant.
 *
 * Accepts, per §6.2 and §7: a bare handle, an @handle, a profile URL on any of
 * the hosts above, the `/with_replies` and `/media` tabs, a search URL, and a
 * list URL. Returns null for anything else — including a link to a single post,
 * which is a thing to read rather than a thing to subscribe to.
 *
 * @param {unknown} input
 * @returns {{ mode: string, username?: string, query?: string, listId?: string }|null}
 */
export function parseXInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // Bare handle or @handle. Checked before the URL parse because `OpenAI` is
  // not a URL and `new URL()` on it throws rather than declining.
  const bare = raw.replace(/^@/, '');
  if (HANDLE.test(bare) && !raw.includes('/') && !raw.includes(':')) {
    return { mode: 'user', username: bare };
  }

  // `r/`-style shorthand has no X equivalent, but `x/OpenAI` and `@x.com`
  // handles do turn up in pasted text, so a scheme-less URL gets one.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const first = segments[0].toLowerCase();

  // A search, in either of the two spellings X itself uses.
  if (first === 'search') {
    const query = url.searchParams.get('q') ?? url.searchParams.get('query') ?? '';
    return query.trim() ? { mode: 'search', query: query.trim() } : null;
  }

  // A list: /i/lists/:id, and the older /:owner/lists/:slug which we cannot
  // resolve to an id without asking X, so it is declined rather than guessed.
  if (first === 'i') {
    const listId = segments[1]?.toLowerCase() === 'lists' ? segments[2] : null;
    return listId && LIST_ID.test(listId) ? { mode: 'list', listId } : null;
  }

  if (NOT_A_HANDLE.has(first)) return null;
  if (!HANDLE.test(segments[0])) return null;

  const username = segments[0];
  const tab = segments[1]?.toLowerCase();

  // A post URL (/:user/status/:id) is deliberately *not* a source. Somebody
  // pasting one wants to read that post, and turning it into a subscription to
  // the whole account is a different thing from what they asked for.
  if (tab === 'status' || tab === 'statuses') return null;

  if (tab === 'with_replies' || tab === 'replies') return { mode: 'replies', username };
  if (tab === 'media' || tab === 'photo') return { mode: 'media', username };
  if (!tab) return { mode: 'user', username };

  // Any other tab (/likes, /following, /highlights) is a page about the account
  // rather than a feed of it.
  return null;
}

/**
 * Our key for a source. Two requests that produce the same ref are the same
 * upstream collector, and the unique index on `feeds.social_ref` enforces it.
 *
 * A search is keyed on its *exact* query text rather than a slug of it, because
 * `from:OpenAI lang:en` and `from:openai lang:en` are the same search to X but
 * `bitcoin` and `bitcoin ETF` are not, and no normalisation is safe across
 * an operator syntax we deliberately do not reimplement (§28).
 *
 * @param {{ mode: string, username?: string, query?: string, listId?: string }} spec
 * @returns {string|null}
 */
export function xRef(spec) {
  if (!spec) return null;
  switch (spec.mode) {
    case 'user':
      return spec.username ? `x:user:${spec.username.toLowerCase()}` : null;
    case 'replies':
      return spec.username ? `x:replies:${spec.username.toLowerCase()}` : null;
    case 'media':
      return spec.username ? `x:media:${spec.username.toLowerCase()}` : null;
    case 'search':
      return spec.query ? `x:search:${spec.query.trim().toLowerCase()}` : null;
    case 'list':
      return spec.listId ? `x:list:${spec.listId}` : null;
    default:
      return null;
  }
}

/**
 * The canonical address on X's side — what goes in `feeds.feed_url`, what the
 * page links out to, and what an item's `link` is relative to.
 *
 * @param {{ mode: string, username?: string, query?: string, listId?: string }} spec
 * @returns {string|null}
 */
export function xUrl(spec) {
  if (!spec) return null;
  switch (spec.mode) {
    case 'user':
      return `https://x.com/${spec.username}`;
    case 'replies':
      return `https://x.com/${spec.username}/with_replies`;
    case 'media':
      return `https://x.com/${spec.username}/media`;
    case 'search':
      return `https://x.com/search?q=${encodeURIComponent(spec.query)}&f=live`;
    case 'list':
      return `https://x.com/i/lists/${spec.listId}`;
    default:
      return null;
  }
}

/**
 * Where the source lives on *this* site.
 *
 * The public URL a reader subscribes to, and the one thing in this file that
 * must never change when the collection method does (AC-2). A provider name
 * appears nowhere in it.
 *
 * @param {{ mode: string, username?: string, query?: string, listId?: string }} spec
 * @returns {string|null} path, no extension — `.rss`/`.atom`/`.json` append
 */
export function xPath(spec) {
  if (!spec) return null;
  switch (spec.mode) {
    case 'user':
      return `/x/${spec.username}`;
    case 'replies':
      return `/x/${spec.username}/replies`;
    case 'media':
      return `/x/${spec.username}/media`;
    case 'search':
      // The query rides in the query string rather than the path. §5 shows a
      // slugged form and §28 the query-string one; only the second can carry
      // `from:OpenAI lang:en` without inventing an escaping scheme, and a
      // reader's subscription URL is not the place to invent one.
      return `/x/search?q=${encodeURIComponent(spec.query)}`;
    case 'list':
      return `/x/list/${spec.listId}`;
    default:
      return null;
  }
}

/**
 * A title for the source, used when the first crawl has not yet learned the
 * account's display name.
 *
 * @param {{ mode: string, username?: string, query?: string, listId?: string }} spec
 * @returns {string}
 */
export function xTitle(spec) {
  switch (spec?.mode) {
    case 'user':
      return `@${spec.username} on X`;
    case 'replies':
      return `@${spec.username} on X — replies`;
    case 'media':
      return `@${spec.username} on X — media`;
    case 'search':
      return `X search: ${spec.query}`;
    case 'list':
      return `X list ${spec.listId}`;
    default:
      return 'X';
  }
}

/**
 * The directory slug for an X source.
 *
 * X sources keep a slug like every other feed, because `/{slug}` is the
 * permanent identity of a row in this directory and half the site's internals
 * (the reader, alerts, the queue, sitemaps) address a feed that way. `/x/…` is
 * the *canonical* public address on top of it — see the canonical link on the
 * feed page — not a replacement for the row's own name.
 *
 * @param {{ mode: string, username?: string, query?: string, listId?: string }} spec
 * @returns {string|null}
 */
export function xSlug(spec) {
  const ref = xRef(spec);
  if (!ref) return null;
  return ref
    .replace(/^x:/, 'x-')
    .replace(/:/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Everything a source row needs, from one pasted string.
 *
 * @param {unknown} input
 * @returns {{
 *   mode: string, username?: string, query?: string, listId?: string,
 *   ref: string, url: string, path: string, slug: string, title: string
 * }|null}
 */
export function xSource(input) {
  const spec = parseXInput(input);
  if (!spec) return null;

  const ref = xRef(spec);
  const url = xUrl(spec);
  const path = xPath(spec);
  const slug = xSlug(spec);
  if (!ref || !url || !path || !slug) return null;

  return { ...spec, ref, url, path, slug, title: xTitle(spec) };
}

/**
 * Rebuild the spec from a stored ref, for the crawler — which holds a row, not
 * the string somebody once pasted.
 *
 * @param {unknown} ref
 * @returns {{ mode: string, username?: string, query?: string, listId?: string }|null}
 */
export function xSpecFromRef(ref) {
  const raw = String(ref ?? '');
  const match = /^x:([a-z]+):([\s\S]+)$/.exec(raw);
  if (!match) return null;

  const [, mode, rest] = match;
  if (!X_MODES.includes(mode)) return null;

  if (mode === 'search') return { mode, query: rest };
  if (mode === 'list') return LIST_ID.test(rest) ? { mode, listId: rest } : null;
  return HANDLE.test(rest) ? { mode, username: rest } : null;
}
