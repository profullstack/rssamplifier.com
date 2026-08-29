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
import { searchFilter } from './searchFilters.js';

/**
 * A saved search, as a feed.
 *
 * `/search.rss?q=lisp` — the query stays in the query string, which is the one
 * thing about this worth knowing: a rewrite's *destination* query never reaches
 * an App Router handler, but the caller's does, because `req.url` there is the
 * URL the client asked for. So `?q=` written by the reader survives and a `?q=`
 * written in next.config.mjs would not.
 *
 * This is the closest thing the directory has to an alert: subscribe to
 * `/search.rss?q=your+name` and a reader tells you when three hundred thousand
 * feeds mention it. (The account-based version of that is /api/alerts, which
 * emails; this one needs no account at all.)
 *
 * @param {{ query: unknown, kind?: unknown, format: string, limit?: unknown }} args
 * @returns {Promise<Response>}
 */
export async function searchRiver({ query: rawQuery, kind: rawKind, format: rawFormat, limit: rawLimit }) {
  const { format, spec } = riverFormat(rawFormat);
  if (!spec) return unsupportedFormat(format);

  // Search rows carry no enclosures — the FTS query selects the text columns —
  // so a playlist here would be an empty file rather than an answer.
  if (spec.media) {
    return riverFail(
      format,
      404,
      `search has no playlist: ${format}`,
      `Try a topic instead — ${siteUrl()}/topics`,
    );
  }

  const query = String(rawQuery ?? '').trim();

  if (!query) {
    return riverFail(
      format,
      400,
      'no query',
      `Ask for something: ${siteUrl()}/search.${format}?q=lisp`,
    );
  }

  const filter = searchFilter(rawKind);
  const limit = riverLimit(rawLimit, 40);

  const client = db();
  // Posts only. The page also lists matching *feeds*, and mixing the two into
  // one document would hand a subscriber an entry that is a directory listing
  // sitting next to entries that are articles — two different kinds of thing
  // under one heading, sorted by a date only one of them has.
  const rows = await q.searchItems(client, query, limit, 'all', filter?.kinds ?? null);

  const page = `${siteUrl()}/search?q=${encodeURIComponent(query)}${
    filter ? `&kind=${encodeURIComponent(filter.segment)}` : ''
  }`;
  const self = `${siteUrl()}/search.${format}?q=${encodeURIComponent(query)}${
    filter ? `&kind=${encodeURIComponent(filter.segment)}` : ''
  }`;

  const channel = {
    title: filter ? `${query} in ${filter.noun} — RSS Amplifier` : `${query} — RSS Amplifier`,
    description: `Posts matching “${query}” from the feeds in the RSS Amplifier directory, best match first.`,
    link: page,
    selfUrl: self,
  };

  const items = rows.map((row) =>
    riverItem(row, {
      // Which publication a hit came from is most of what makes a search result
      // usable, and unlike the page there is no thumbnail here to imply it.
      feedTitle: row.feed_title ? String(row.feed_title) : null,
      feedSlug: row.feed_slug ? String(row.feed_slug) : null,
    }),
  );

  return riverResponse({
    format,
    spec,
    channel,
    items,
    filename: `search-${query}`,
    src: 'search',
    // Half the topic window: a search feed is a standing question, and a reader
    // polling one has usually just set it up and wants to see it work.
    maxAge: 150,
  });
}
