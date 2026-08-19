/*
 * Our copy of a river, whatever the river is.
 *
 * Every listing on this site is a list of things somebody published, and until
 * now only one of them — a topic — could be subscribed to. Everything else
 * pointed a reader who wanted a feed at *somebody else's* feed URL, which is a
 * strange thing for a directory to do: the reader leaves, the page they were on
 * stops being the address they come back to, and nothing we know about the feed
 * (the summaries we cleaned, the author we credited, the reader link) travels
 * with them.
 *
 * So each surface publishes its own document at its own address, and this holds
 * the parts they all share: pick the renderer, decide how many sponsored items
 * the document can carry, fetch them, interleave them, and answer with the
 * right content type. What differs per surface is the query and the channel
 * blurb, which is exactly what each caller passes in.
 *
 * The ad rule is not restated here — `adSlotsFor` and `interleaveAds` in
 * @rssamplifier/feed own it, one in ten, three at most, never trailing — and
 * that is deliberate: the count we fetch has to be the count we publish, or an
 * advertiser is metered for reach that never left the building.
 */

import { SYNDICATION_FORMATS, adSlotsFor, buildSyndication, interleaveAds, playable } from '@rssamplifier/feed';

import { fetchFeedAds } from './feedAds.js';

/** How many items a river carries by default, and at most. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/**
 * Read `?limit=`, and refuse to be surprised by it.
 *
 * @param {unknown} raw
 * @param {number} [fallback]
 * @returns {number}
 */
export function riverLimit(raw, fallback = DEFAULT_LIMIT) {
  return Math.min(Math.max(Number(raw ?? fallback) || fallback, 1), MAX_LIMIT);
}

/**
 * The renderer for an extension, or nothing.
 *
 * @param {unknown} raw
 * @returns {{ format: string, spec: { type: string, label: string, media: boolean }|null }}
 */
export function riverFormat(raw) {
  const format = String(raw ?? '').toLowerCase();
  return { format, spec: SYNDICATION_FORMATS.get(format) ?? null };
}

/**
 * The 404 a caller gets for an extension we do not render.
 *
 * @param {string} format
 * @returns {Response}
 */
export function unsupportedFormat(format) {
  return riverFail(
    'json',
    404,
    `unsupported format: ${format}`,
    `Supported: ${[...SYNDICATION_FORMATS.keys()].join(', ')}`,
  );
}

/**
 * Build and answer.
 *
 * @param {{
 *   format: string,
 *   spec: { type: string, media: boolean },
 *   channel: { title: string, description: string, link: string, selfUrl: string },
 *   items: object[],
 *   filename: string,
 *   src: string,
 *   maxAge?: number,
 * }} args `src` tags the impression so one CrawlProof slot can tell its
 *   surfaces apart; `filename` is the stem, without the extension.
 * @returns {Promise<Response>}
 */
export async function riverResponse({
  format,
  spec,
  channel,
  items,
  filename,
  src,
  maxAge = 300,
}) {
  // A playlist can only carry files. Filtering here rather than in every query
  // keeps the surfaces from each inventing their own idea of what is playable.
  const rows = spec.media ? items.filter(playable) : items;

  // Sponsored items, one in ten. Never in a playlist: a sponsored line has
  // nothing for a player to open, and VLC handed one shows an error.
  //
  // The count is worked out before the fetch, so a river too short to carry an
  // ad never pays for the round trip.
  const wanted = spec.media ? 0 : adSlotsFor(rows.length);
  const ads = wanted > 0 ? await fetchFeedAds(wanted, { src }) : [];

  const body = buildSyndication(format, channel, interleaveAds(rows, ads));

  return new Response(body, {
    headers: {
      'content-type': spec.type,
      'content-disposition': `inline; filename="${riverFilename(filename, format)}"`,
      'access-control-allow-origin': '*',
      'cache-control': `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=3600`,
    },
  });
}

/**
 * A filename a reader or a player will not be embarrassed by.
 *
 * @param {string} stem
 * @param {string} format
 * @returns {string}
 */
export function riverFilename(stem, format) {
  const safe = String(stem).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'feed';
  return `rssamplifier-${safe}.${format}`;
}

/**
 * An error a caller can read in whichever shape they asked for.
 *
 * A feed reader handed JSON where it expected XML reports a parse failure
 * rather than a missing feed, which sends whoever is debugging it to entirely
 * the wrong place — so the response type follows the request.
 *
 * @param {string} format
 * @param {number} status
 * @param {string} error
 * @param {string} hint
 * @returns {Response}
 */
export function riverFail(format, status, error, hint) {
  const json = format === 'json';
  const body = json ? `${JSON.stringify({ error, hint }, null, 2)}\n` : `${error}\n${hint}\n`;

  return new Response(body, {
    status,
    headers: {
      'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * The item shape the renderers take, from a `feed_items` row.
 *
 * The publisher's guid is the identity, not our row id: a re-crawl can renumber
 * our rows, and a reader that keyed on those would show every post twice the
 * day it happened.
 *
 * @param {object} row
 * @param {{ feedTitle?: string|null, feedSlug?: string|null, feedUrl?: string|null }} [ctx]
 * @returns {object}
 */
export function riverItem(row, ctx = {}) {
  return {
    ...row,
    id: String(row.guid ?? row.url ?? row.id ?? ''),
    ...(ctx.feedTitle ? { feed_title: ctx.feedTitle } : {}),
    ...(ctx.feedSlug ? { feed_slug: ctx.feedSlug } : {}),
    ...(ctx.feedUrl ? { feed_url: ctx.feedUrl } : {}),
  };
}
