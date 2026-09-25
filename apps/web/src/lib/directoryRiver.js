import { q } from '@rssamplifier/db';

import { CATEGORIES, CATEGORY_SEGMENTS, viewName } from './categories.js';
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
 * One category is the exception, and only because it is bounded. A category
 * that leads with its entries on the page — `river` in the table, which today
 * is podcasts — leads with them here too, because this address is the page in
 * a form a reader app can poll, and a feed that disagreed with the page it is
 * advertised on is worse than no feed. `?view=shows` asks for the other one,
 * spelled exactly as the page spells it.
 *
 * @param {{ kind?: string|null, format: string, limit?: unknown, view?: unknown }} args
 * @returns {Promise<Response>}
 */
export async function directoryRiver({
  kind: rawKind = null,
  format: rawFormat,
  limit: rawLimit,
  view: rawView = null,
}) {
  const { format, spec } = riverFormat(rawFormat);
  if (!spec) return unsupportedFormat(format);

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

  // A playlist of *feeds* is not a thing: a directory entry has nothing to
  // play, and rendering an empty M3U would look like a bug rather than a
  // refusal. A category that publishes its entries here is the exception —
  // /podcasts.m3u is the newest episode of every show in one file, which is
  // the most useful thing this address could possibly mean.
  if (spec.media && !category?.river) {
    return riverFail(
      format,
      404,
      `the directory has no playlist: ${format}`,
      `A directory entry is a feed, not a file. Try ${siteUrl()}/podcasts.${format}, a topic — ${siteUrl()}/topics — or one feed's own ${format}.`,
    );
  }

  const limit = riverLimit(rawLimit);
  const client = db();
  const page = category ? `${siteUrl()}${category.path}` : siteUrl();
  // A playlist is always of entries, whatever `?view=` says. It only got past
  // the guard above because this category publishes them, and a playlist of
  // feeds is the empty file that guard exists to prevent.
  const entries = spec.media || viewName(rawView, category ?? {}) === 'latest';

  if (entries && category && kind) {
    const rows = await q.latestItems(client, { kinds: [kind], limit });

    return riverResponse({
      format,
      spec,
      channel: {
        title: `New ${category.item} — RSS Amplifier`,
        description: `The newest ${category.item} across every ${category.one} in the RSS Amplifier directory.`,
        link: page,
        selfUrl: `${page}.${format}`,
      },
      // A post's own guid, the identity every other river on the site uses, so
      // a re-crawl that renumbers our rows cannot make a reader show the same
      // episode twice.
      items: rows.map((row) => ({
        id: String(row.guid ?? row.url ?? ''),
        // Whose it is, in the title: this is the one river here drawn from
        // hundreds of publications at once, and a reader app showing a flat
        // list of episode titles gives no clue which show each came from.
        title: `${String(row.feed_title ?? '')}: ${String(row.title ?? 'Untitled')}`,
        url: `${siteUrl()}/${row.feed_slug}/read?p=${encodeURIComponent(String(row.guid))}`,
        summary: row.summary ? String(row.summary) : undefined,
        image_url: row.image_url ? String(row.image_url) : (row.feed_image ?? undefined),
        published_at: row.published_at ? String(row.published_at) : undefined,
        author: row.author ? String(row.author) : undefined,
        audio_url: row.audio_url ? String(row.audio_url) : undefined,
        audio_type: row.audio_type ? String(row.audio_type) : undefined,
        audio_bytes: row.audio_bytes ?? undefined,
        audio_seconds: row.audio_seconds ?? undefined,
      })),
      filename: `new-${kind}-${category.item}`,
      src: `directory-${kind}-entries`,
    });
  }

  const rows = await q.listFeeds(client, { limit, kind });

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
