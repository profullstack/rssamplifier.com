import { q } from '@rssamplifier/db';

import { CATEGORIES, CATEGORY_SEGMENTS } from './categories.js';
import { db, siteUrl } from './db.js';
import {
  riverFail,
  riverFormat,
  riverLimit,
  riverResponse,
  unsupportedFormat,
} from './river.js';

/**
 * The directory itself, as a feed: what has just been added to it.
 *
 * `/feed.rss` for everything, `/blogs.rss`, `/podcasts.rss` and the rest for one
 * category. These are the only rivers on the site whose entries are *feeds*
 * rather than posts, and that is the honest reading of the pages they belong
 * to: the index lists what was newly indexed, newest first, so its feed says
 * "here is what turned up in the directory this week".
 *
 * A river of every post from every blog in the directory is the other thing
 * this address could have meant. It is not this: three hundred thousand feeds
 * publish faster than any reader would thank us for, and the per-topic and
 * per-feed rivers already answer "tell me when *this* is published".
 *
 * @param {{ kind?: string|null, format: string, limit?: unknown }} args
 * @returns {Promise<Response>}
 */
export async function directoryRiver({ kind: rawKind = null, format: rawFormat, limit: rawLimit }) {
  const { format, spec } = riverFormat(rawFormat);
  if (!spec) return unsupportedFormat(format);

  // A playlist of feeds is not a thing: a directory entry has nothing to play,
  // and rendering an empty M3U would look like a bug rather than a refusal.
  if (spec.media) {
    return riverFail(
      format,
      404,
      `the directory has no playlist: ${format}`,
      `A directory entry is a feed, not a file. Try a topic — ${siteUrl()}/topics — or one feed's own ${format}.`,
    );
  }

  // Both spellings resolve: the plural the URL uses (`/podcasts.rss`, which is
  // the page's own path) and the singular the database stores. The rewrite
  // hands over the former and a caller reading the API directly is as likely to
  // write the latter, and refusing one of them would be a distinction with no
  // reason behind it.
  const asked = rawKind ? String(rawKind).toLowerCase() : null;
  const kind = asked ? (CATEGORIES[asked] ? asked : (CATEGORY_SEGMENTS.get(asked) ?? null)) : null;
  const category = kind ? CATEGORIES[kind] : null;

  if (asked && !category) {
    return riverFail(format, 404, `no such category: ${asked}`, `Browse ${siteUrl()}`);
  }

  const limit = riverLimit(rawLimit);
  const client = db();
  const rows = await q.listFeeds(client, { limit, kind });

  const page = category ? `${siteUrl()}${category.path}` : siteUrl();

  const channel = {
    title: category ? `New ${category.noun} — RSS Amplifier` : 'New in RSS Amplifier',
    description: category
      ? `${category.heading} as they are added to the RSS Amplifier directory, newest first.`
      : 'Blogs, podcasts and other feeds as they are added to the RSS Amplifier directory, newest first.',
    link: page,
    selfUrl: category ? `${page}.${format}` : `${siteUrl()}/feed.${format}`,
  };

  // A directory entry as an item. The link is our page for the feed, not the
  // publisher's site: a reader who followed this river wants the thing they can
  // subscribe to from, and that page carries the subscribe links, the archive
  // and the reader.
  const items = rows.map((row) => ({
    id: `feed:${row.slug}`,
    title: String(row.title ?? row.slug),
    url: `${siteUrl()}/${row.slug}`,
    summary: row.description ? String(row.description) : undefined,
    image_url: row.card_url ? String(row.card_url) : (row.image_url ?? undefined),
    // When it joined the directory, which is what this river is ordered by.
    // Using the feed's own last_published_at instead would sort the document
    // differently from the page it mirrors, and readers sort by date.
    published_at: row.created_at ? String(row.created_at) : undefined,
    author: row.author ? String(row.author) : undefined,
  }));

  return riverResponse({
    format,
    spec,
    channel,
    items,
    filename: category ? `new-${kind}` : 'new',
    src: category ? `directory-${kind}` : 'directory',
  });
}
