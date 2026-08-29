/**
 * One question asked of every platform: "is this URL one of ours?"
 *
 * The submit path, the importer and the crawler all need to recognise a social
 * URL before they know which platform it belongs to, and none of them should
 * have to try each parser in turn and remember the order. So the ordering lives
 * here, once.
 *
 * It matters that this runs *before* the ordinary feed resolver. Reddit does
 * publish RSS, so `https://www.reddit.com/r/programming/` resolves perfectly
 * well as a plain feed — and lands as an untyped row at a slug of its own,
 * which is exactly the 50,026-row outcome `reddit/canonical.js` describes. The
 * difference between a subreddit at `/r/programming` and a subreddit filed
 * among the blogs is entirely a matter of who looks at the URL first.
 */

import { xSource } from './x/canonical.js';
import { redditSource } from './reddit/canonical.js';
import { instagramSource } from './instagram/canonical.js';
import { facebookSource } from './facebook/canonical.js';

/** The networks that get a namespace of their own. */
export const SOCIAL_NETWORKS = Object.freeze(['reddit', 'x', 'instagram', 'facebook']);

/**
 * The prefix each network's refs use, and the path each lives under.
 *
 * A table rather than four `if`s in `socialPathFor`, because that function is
 * called from listings and would otherwise grow a branch per platform in a
 * place nobody thinks to look when adding one.
 */
const BY_PREFIX = {
  'r:sub': (name) => `/r/${name}`,
  'r:user': (name) => `/r/u/${name}`,
  'x:user': (name) => `/x/${name}`,
  'x:replies': (name) => `/x/${name}/replies`,
  'x:media': (name) => `/x/${name}/media`,
  'x:list': (id) => `/x/list/${id}`,
  'x:search': (query) => `/x/search?q=${encodeURIComponent(query)}`,
  'ig:user': (name) => `/ig/${name}`,
  'ig:tag': (tag) => `/ig/tag/${tag}`,
  'fb:page': (page) => `/fb/${page}`,
};

/**
 * The recognisers, in the order they get to claim a string.
 *
 * **The order is load-bearing in exactly one place.** A bare `@handle` is a
 * valid input to both X and Instagram, and X is tried first because it had the
 * spelling first and because `/submit` has accepted it since PR #156. Instagram
 * is reachable explicitly, as `ig/handle` or a full URL — see the note in
 * `instagram/canonical.js`. Everything else is disambiguated by hostname and
 * the order is irrelevant.
 */
const RECOGNISERS = [
  ['reddit', redditSource],
  ['facebook', facebookSource],
  // X before Instagram, and only because of the bare-handle case. Both accept a
  // bare `@handle`; whichever is asked first wins it. Reddit and Facebook are
  // above them because neither claims a bare handle at all, so their position is
  // arbitrary and their hostnames disambiguate them.
  ['x', xSource],
  ['instagram', instagramSource],
];

/**
 * Recognise a social source, or say it is not one.
 *
 * @param {unknown} input anything a person or an importer might supply
 * @returns {{
 *   network: 'reddit'|'x'|'instagram'|'facebook',
 *   ref: string,
 *   slug: string,
 *   title: string,
 *   path: string,
 *   feedUrl: string,
 *   siteUrl: string|null,
 * }|null}
 */
export function socialSourceFrom(input) {
  for (const [network, recognise] of RECOGNISERS) {
    const found = recognise(input);
    if (!found) continue;

    return {
      network,
      ref: found.ref,
      slug: found.slug,
      title: found.title,
      path: found.path,
      // Reddit is the only one of the four with a document at the other end.
      // For the rest this is the canonical public address of the thing on the
      // platform's side: nothing fetches it, and it is stored because
      // `feeds.feed_url` is `not null unique` and is what every surface reads
      // to show a human where a feed came from.
      feedUrl: found.feedUrl ?? found.url,
      siteUrl: found.siteUrl ?? found.url ?? null,
    };
  }

  return null;
}

/**
 * Where a stored row lives on this site, from its own columns.
 *
 * The fallback is `/{slug}`, which is every non-social feed and also any social
 * row whose ref predates this code — so a caller can use this everywhere
 * without checking whether a feed is social first.
 *
 * @param {{ social_ref?: string|null, slug?: string }} feed
 * @returns {string}
 */
export function socialPathFor(feed) {
  const ref = feed?.social_ref ? String(feed.social_ref) : null;
  if (!ref) return `/${String(feed?.slug ?? '')}`;

  // Split on the *second* colon only: a search ref is `x:search:<query>` and a
  // query may contain colons of its own (`from:OpenAI`), so splitting on every
  // colon would truncate it.
  const separator = ref.indexOf(':', ref.indexOf(':') + 1);
  if (separator === -1) return `/${String(feed?.slug ?? '')}`;

  const prefix = ref.slice(0, separator);
  const rest = ref.slice(separator + 1);

  const build = BY_PREFIX[prefix];
  return build && rest ? build(rest) : `/${String(feed?.slug ?? '')}`;
}
