/**
 * One question asked of both platforms: "is this URL one of ours?"
 *
 * The submit path, the importer and the crawler all need to recognise a social
 * URL before they know which platform it belongs to, and none of them should
 * have to try each parser in turn and remember the order. So the ordering lives
 * here, once.
 *
 * It matters that this runs *before* the ordinary feed resolver. Reddit does
 * publish RSS, so `https://www.reddit.com/r/programming/` resolves perfectly
 * well as a plain feed — and lands as an untyped row at a slug of its own,
 * which is exactly the 50,099-row outcome `reddit/canonical.js` describes. The
 * difference between a subreddit at `/r/programming` and a subreddit filed
 * among the blogs is entirely a matter of who looks at the URL first.
 */

import { xSource } from './x/canonical.js';
import { redditSource } from './reddit/canonical.js';

/** The networks that get a namespace of their own. */
export const SOCIAL_NETWORKS = Object.freeze(['x', 'reddit']);

/**
 * Recognise a social source, or say it is not one.
 *
 * @param {unknown} input anything a person or an importer might supply
 * @returns {{
 *   network: 'x'|'reddit',
 *   ref: string,
 *   slug: string,
 *   title: string,
 *   path: string,
 *   feedUrl: string,
 *   siteUrl: string|null,
 * }|null}
 */
export function socialSourceFrom(input) {
  const reddit = redditSource(input);
  if (reddit) {
    return {
      network: 'reddit',
      ref: reddit.ref,
      slug: reddit.slug,
      title: reddit.title,
      path: reddit.path,
      feedUrl: reddit.feedUrl,
      siteUrl: reddit.siteUrl,
    };
  }

  const x = xSource(input);
  if (x) {
    return {
      network: 'x',
      ref: x.ref,
      slug: x.slug,
      title: x.title,
      path: x.path,
      // For X there is no document at this address and nothing ever fetches it.
      // It is here because `feeds.feed_url` is `not null unique` and is the
      // column every other surface reads to show a human where a feed came
      // from — see the header of x/canonical.js.
      feedUrl: x.url,
      siteUrl: x.url,
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
 * @param {{ social_network?: string|null, social_ref?: string|null, slug?: string }} feed
 * @returns {string}
 */
export function socialPathFor(feed) {
  const ref = feed?.social_ref ? String(feed.social_ref) : null;
  const slug = String(feed?.slug ?? '');

  if (ref?.startsWith('r:')) {
    const [, mode, name] = ref.split(':');
    if (name) return mode === 'user' ? `/r/u/${name}` : `/r/${name}`;
  }

  if (ref?.startsWith('x:')) {
    const separator = ref.indexOf(':', 2);
    const mode = ref.slice(2, separator);
    const rest = ref.slice(separator + 1);
    if (mode === 'user') return `/x/${rest}`;
    if (mode === 'replies') return `/x/${rest}/replies`;
    if (mode === 'media') return `/x/${rest}/media`;
    if (mode === 'list') return `/x/list/${rest}`;
    if (mode === 'search') return `/x/search?q=${encodeURIComponent(rest)}`;
  }

  return `/${slug}`;
}
