import { authors as people } from '@rssamplifier/db';

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
 * One person, as a feed: everything they publish, wherever they publish it.
 *
 * `/authors/ada-lovelace.rss` and the rest, by rewrite. This is the one river
 * on the site that does not exist anywhere else — a writer with a blog, a
 * newsletter and a podcast has three feeds and no way to hand somebody all
 * three, and the directory already knows which feeds are theirs because the
 * author extractor credited them. Subscribing to the person rather than to the
 * publication is the thing this page was for and could not previously offer.
 *
 * @param {{ slug: string, format: string, limit?: unknown }} args
 * @returns {Promise<Response>}
 */
export async function authorRiver({ slug: rawSlug, format: rawFormat, limit: rawLimit }) {
  const { format, spec } = riverFormat(rawFormat);
  if (!spec) return unsupportedFormat(format);

  const slug = String(rawSlug ?? '').toLowerCase();
  const limit = riverLimit(rawLimit);

  const client = db();
  const author = await people.authorBySlug(client, slug);

  if (!author) {
    return riverFail(format, 404, `no such author: ${slug}`, `Browse ${siteUrl()}/authors`);
  }

  const page = `${siteUrl()}/authors/${encodeURIComponent(slug)}`;
  const feeds = author.feeds ?? [];
  const rows = await people.postsByAuthor(
    client,
    feeds.map((f) => f.id),
    limit,
  );

  const channel = {
    title: `${author.name} — RSS Amplifier`,
    description:
      feeds.length > 1
        ? `Everything ${author.name} publishes, across ${feeds.length} feeds in the RSS Amplifier directory.`
        : `Everything ${author.name} publishes, via the RSS Amplifier directory.`,
    link: page,
    selfUrl: `${page}.${format}`,
  };

  // The publication *is* worth naming on every item here, unlike a single
  // feed's river: the whole point of this document is that its entries come
  // from more than one place, and a reader looking at one post should be able
  // to see which of the author's feeds it arrived in.
  const items = rows.map((row) =>
    riverItem(row, {
      feedTitle: row.feed_title ? String(row.feed_title) : null,
      feedSlug: row.feed_slug ? String(row.feed_slug) : null,
      feedUrl: row.feed_url ? String(row.feed_url) : null,
    }),
  );

  return riverResponse({ format, spec, channel, items, filename: `author-${slug}`, src: 'author' });
}
