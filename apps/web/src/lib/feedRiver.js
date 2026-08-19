import { q } from '@rssamplifier/db';

import { db, siteUrl } from './db.js';
import {
  riverFail,
  riverFormat,
  riverItem,
  riverLimit,
  riverResponse,
  unsupportedFormat,
} from './river.js';
import { wantsPlayer } from './player.js';

/**
 * One blog, podcast or newsroom in the directory, as a feed of ours.
 *
 * `/phoenix-fm.rss`, `.atom`, `.json`, `.md`, `.m3u`, `.pls` — a rewrite onto
 * this (see next.config.mjs), so the address a reader subscribes to is the same
 * address they were reading, plus an extension.
 *
 * **Why publish a copy of somebody else's feed at all.** The feed page used to
 * offer one subscribe link and it pointed at the publisher's own URL. That is a
 * link out of the directory at the exact moment somebody decided they liked
 * what they found: the reader subscribes elsewhere, never comes back, and none
 * of the work this site did travels with them. Our copy carries the summaries
 * the crawler cleaned, the reader link that opens the post here, the author we
 * credited, and — the honest part of the bargain — the sponsored items that pay
 * for the crawl. The publisher's original stays on the page, one line down and
 * labelled as theirs, because a directory that hides where a feed came from is
 * a worse directory.
 *
 * **It is a copy, not a proxy.** These items come out of our database, so the
 * document says what we last crawled rather than what the publisher served a
 * second ago. That is the same freshness the page has, and the page states it
 * (see Freshness) — a subscriber gets posts within a crawl interval, which for
 * a live feed is minutes.
 *
 * @param {{ slug: string, format: string, limit?: unknown, req?: Request }} args
 * @returns {Promise<Response>}
 */
export async function feedRiver({ slug: rawSlug, format: rawFormat, limit: rawLimit, req = null }) {
  const { format, spec } = riverFormat(rawFormat);
  if (!spec) return unsupportedFormat(format);

  const slug = String(rawSlug ?? '').toLowerCase();
  const limit = riverLimit(rawLimit);

  const client = db();
  const feed = await q.feedBySlug(client, slug);

  if (!feed) {
    return riverFail(format, 404, `no such feed: ${slug}`, `Browse ${siteUrl()}`);
  }

  // A browser asked for a playlist, and no browser plays one — see lib/player.js.
  // A topic has a player page to be sent to; a feed page already *is* one, with
  // a play control on every episode, so that is where this lands. 303 rather
  // than 302 because the page and the playlist are genuinely different
  // resources, and 303 says so without implying the file moved.
  if (spec.media && wantsPlayer(req)) {
    return Response.redirect(`${siteUrl()}/${encodeURIComponent(slug)}`, 303);
  }

  const page = `${siteUrl()}/${encodeURIComponent(slug)}`;
  const rows = await q.itemsForFeed(client, String(feed.id), limit);

  const channel = {
    title: String(feed.title ?? slug),
    // The publisher's own description when there is one. A blurb of ours in
    // front of it would be this directory talking over the feed it is
    // republishing, in the one field a reader sees under the title.
    description: String(
      feed.description ?? `Posts from ${feed.title ?? slug}, via the RSS Amplifier directory.`,
    ),
    link: page,
    selfUrl: `${page}.${format}`,
    language: feed.language ? String(feed.language) : undefined,
  };

  // No feed_title on the items, unlike a topic or a search river: every entry
  // here came from the same publication, and stamping its name on all fifty
  // would only repeat the channel title fifty times.
  const items = rows.map((row) => riverItem(row));

  return riverResponse({
    format,
    spec,
    channel,
    items,
    filename: slug,
    src: 'feed',
  });
}
