import { q, social } from '@rssamplifier/db';
import { redditSource, xSource } from '@rssamplifier/social';

import { db, siteUrl } from './db.js';
import {
  riverFail,
  riverFormat,
  riverItem,
  riverLimit,
  riverResponse,
  unsupportedFormat,
} from './river.js';

/**
 * A social source, as a feed of ours, at the address people already know.
 *
 * `/r/programming.rss` and `/x/OpenAI.rss` are the same machinery as
 * `/{slug}.rss` — the same items, the same renderer, the same ads — differing
 * in exactly one way: the source is found by its canonical ref rather than by
 * its slug, and the document says `/r/programming` is its own address.
 *
 * That last part is the entire contract with a subscriber. §5 and AC-2 ask that
 * these URLs never change, and the thing most likely to change underneath them
 * is which provider collected the posts — so the provider appears in neither
 * the address nor the document. A reader subscribed today through RSSHub is
 * subscribed tomorrow through Teapot without noticing, because there is nothing
 * in what they hold that could tell them.
 *
 * **Nothing here touches X or Reddit.** The items come out of our database;
 * the crawler put them there minutes ago. That is what makes AC-4 true by
 * construction rather than by a cache: a hundred requests are a hundred reads
 * of one row's items, and the upstream sees none of them. It is also what makes
 * AC-5 true — an upstream that is down changes nothing about this path, because
 * this path never asked it anything.
 */

/**
 * Serve one social source in one format.
 *
 * @param {{
 *   ref: string,
 *   canonical: string,
 *   format: string,
 *   limit?: unknown,
 *   req?: Request,
 *   label?: string,
 *   query?: string|null,
 * }} args `canonical` is the path this document lives at — `/r/programming` —
 *   without an extension. `query` is the query string a search feed keeps, and
 *   it goes *after* the extension: `/x/search.rss?q=bitcoin`, never
 *   `/x/search?q=bitcoin.rss`. Getting that the wrong way round produces a
 *   document whose stated address is a different search, which is the sort of
 *   thing a reader only discovers when their subscription drifts.
 * @returns {Promise<Response>}
 */
export async function socialRiver({
  ref,
  canonical,
  format: rawFormat,
  limit: rawLimit,
  req = null,
  label = null,
  query = null,
}) {
  const { format, spec } = riverFormat(rawFormat);
  if (!spec) return unsupportedFormat(format);

  const client = db();
  const feed = await social.feedBySocialRef(client, ref);

  const suffix = query ? `?${query}` : '';

  if (!feed) {
    // A 404 with a way forward. Most misses here are a real account nobody has
    // added yet rather than a typo, and the page at `canonical` is the one that
    // offers to add it — so the hint points at a working next step instead of
    // at the front door.
    return riverFail(
      format,
      404,
      `not in the directory: ${label ?? ref}`,
      `Add it at ${siteUrl()}${canonical}${suffix}`,
    );
  }

  const page = `${siteUrl()}${canonical}`;
  const rows = await q.itemsForFeed(client, String(feed.id), riverLimit(rawLimit));

  const channel = {
    title: String(feed.title ?? label ?? ref),
    description: String(
      feed.description ?? `${label ?? ref}, mirrored by the RSS Amplifier directory.`,
    ),
    link: `${page}${suffix}`,
    selfUrl: `${page}.${format}${suffix}`,
    language: feed.language ? String(feed.language) : undefined,
  };

  return riverResponse({
    format,
    spec,
    channel,
    items: rows.map((row) => riverItem(row)),
    // The stem of the downloaded filename. `rssamplifier-r-programming.rss`
    // rather than the row's slug, so what lands in a Downloads folder matches
    // the URL it was fetched from.
    filename: canonical.replace(/^\//, '').replace(/\//g, '-'),
    src: 'social',
    req,
  });
}

/**
 * The canonical ref and path for a `/r/…` request, or null if it is not one.
 *
 * Parsing rather than pattern-matching, so `/r/Programming.rss` and
 * `/r/programming.rss` reach the same source: Reddit's own URLs are
 * case-insensitive, and two rows for one community is exactly what §38 exists
 * to prevent.
 *
 * @param {{ subreddit?: string, username?: string }} params
 * @returns {{ ref: string, canonical: string, label: string }|null}
 */
export function redditTarget(params) {
  const source = params.username
    ? redditSource(`u/${params.username}`)
    : redditSource(`r/${params.subreddit}`);

  if (!source) return null;
  return { ref: source.ref, canonical: source.path, label: source.title };
}

/**
 * The same for `/x/…`, across all five modes.
 *
 * @param {{ username?: string, mode?: string, listId?: string, query?: string }} params
 * @returns {{ ref: string, canonical: string, label: string, query: string|null }|null}
 */
export function xTarget(params) {
  const input = params.query
    ? `https://x.com/search?q=${encodeURIComponent(params.query)}`
    : params.listId
      ? `https://x.com/i/lists/${params.listId}`
      : params.mode === 'replies'
        ? `https://x.com/${params.username}/with_replies`
        : params.mode === 'media'
          ? `https://x.com/${params.username}/media`
          : `https://x.com/${params.username ?? ''}`;

  const source = xSource(input);
  if (!source) return null;

  // A search's path carries its query, and the two have to be handed back apart
  // so the extension can go between them — see the note on `query` above.
  const [canonical, query = null] = source.path.split('?');
  return { ref: source.ref, canonical, label: source.title, query };
}
