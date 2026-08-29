import { q } from '@rssamplifier/db';
import {
  SYNDICATION_FORMATS,
  adSlotsFor,
  buildSyndication,
  interleaveAds,
} from '@rssamplifier/feed';

import { db, siteUrl } from './db.js';
import { fetchFeedAds } from './feedAds.js';
import { playerPath, wantsPlayer } from './player.js';
import { slugFromUrl, topicGroup } from './topicGroups.js';

/** How many items a topic feed carries by default, and at most. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The queue length the player pages render.
 *
 * Exported so the page and the playlist it stands in for cannot drift: a reader
 * who plays a topic in the browser and then downloads the same topic as an
 * `.m3u` should get the same episodes in the same order, and they will only
 * keep doing that if there is one number.
 */
export const PLAYLIST_LIMIT = DEFAULT_LIMIT;

/**
 * One topic — or one category of it — as something a reader can subscribe to.
 *
 * The addressable forms are extensions on the pages themselves:
 * `/topics/physics.rss` and `/topics/physics/podcasts.m3u`, both rewrites onto
 * the two route handlers that call this (see next.config.mjs). The document
 * names the pretty URL as its `rel="self"`, so a reader that arrived by the API
 * path still records the canonical address.
 *
 * This lives in lib rather than in a route because the group is a **path
 * segment** rather than a query parameter, and that gives it two routes. It has
 * to be a segment: a rewrite's destination query string does not reach an App
 * Router handler — `req.url` is the URL the client asked for, not the one the
 * rewrite produced — so `?group=` written in next.config.mjs would silently
 * arrive as nothing and every sub-group feed would quietly serve the whole
 * topic. The same reason the format is a segment here rather than an extension.
 *
 * What comes back is a **river**: recent posts from the feeds filed under the
 * topic, not a listing of those feeds. The listing already exists in two forms
 * — the topic page, and `/api/topics/:slug` as JSON — and the two answer
 * different questions. A reader subscribing to `/topics/physics.rss` wants to be
 * told when somebody writes about physics, not to be handed a directory.
 *
 * @param {{
 *   keyword: string,
 *   format: string,
 *   group?: string|null,
 *   limit?: unknown,
 *   req?: Request,
 * }} args `req` is the incoming request, needed only to tell a browser from a player
 * @returns {Promise<Response>}
 */
export async function topicFeed({
  keyword,
  format: rawFormat,
  group: rawGroup = null,
  limit: rawLimit,
  req = null,
}) {
  const format = String(rawFormat ?? '').toLowerCase();
  const spec = SYNDICATION_FORMATS.get(format);

  if (!spec) {
    return fail(
      'json',
      404,
      `unsupported format: ${format}`,
      `Supported: ${[...SYNDICATION_FORMATS.keys()].join(', ')}`,
    );
  }

  // Normalised the same way the page and the JSON endpoint normalise it, so
  // "Home Lab", "home-lab" and "home lab" are all one feed rather than three
  // addresses for it.
  const slug = slugFromUrl(keyword);
  const limit = Math.min(
    Math.max(Number(rawLimit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  // A group nobody recognises is ignored rather than refused: the caller gets
  // the whole topic, which is the answer they would have had before asking. The
  // pages are stricter — an unknown sub-group there is a 404, because a page is
  // an address somebody can link to and a feed is a subscription somebody has
  // already made.
  const group = topicGroup(rawGroup);

  // A browser asked for a playlist. No browser can play one — see lib/player.js
  // — so it is sent to the page that can, rather than to its downloads folder
  // with a file nothing on the machine may be registered to open. Only the
  // playlist formats: a browser opening `.rss` gets the feed, which it has
  // always been able to render and which some readers rely on seeing.
  //
  // 303 rather than 302, because what the reader asked for and what they are
  // being given are genuinely different resources, and 303 is the status that
  // says so without implying the playlist has moved.
  if (spec.media && wantsPlayer(req)) {
    return Response.redirect(
      `${siteUrl()}${playerPath(slug, group?.segment ?? null)}`,
      303,
    );
  }

  const client = db();
  const topic = await q.topicBySlug(client, slug);

  if (!topic) {
    return fail(format, 404, `no such topic: ${slug}`, `Browse ${siteUrl()}/topics`);
  }

  // A playlist can only carry files, so it is drawn from a different query than
  // a feed is — see mediaForTopic for why that is not just a filter.
  const kinds = group?.kinds ?? null;
  const [rows, counts] = await Promise.all([
    spec.media
      ? q.mediaForTopic(client, slug, { limit, kinds })
      : q.itemsForTopic(client, slug, { limit, kinds }),
    group ? q.topicKindCounts(client, slug) : Promise.resolve({}),
  ]);

  const base = `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}`;
  const page = group ? `${base}/${group.segment}` : base;
  const subject = group ? `${topic.keyword} (${group.noun})` : topic.keyword;

  // A sub-group's own count, not the topic's: a reader told that 5,426 feeds
  // cover a topic and then handed a river of six podcasts has been told
  // something false about what they subscribed to. Only asked for when a group
  // was requested, so the plain topic feed still costs one count.
  const covering = group
    ? group.kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0)
    : topic.feedCount;

  const channel = {
    title: `${subject} — RSS Amplifier`,
    description: spec.media
      ? `Playable media from the ${covering} feeds in the RSS Amplifier directory that cover ${topic.keyword}.`
      : `Recent posts from the ${covering} feeds in the RSS Amplifier directory that cover ${topic.keyword}.`,
    link: page,
    selfUrl: `${page}.${format}`,
  };

  const items = rows.map((row) => ({
    ...row,
    // The publisher's guid is the item's identity everywhere else in this
    // codebase, and it is what keeps a reader from showing the same post
    // twice after a re-crawl renumbers our own row ids.
    id: String(row.guid ?? row.url ?? ''),
  }));

  // Sponsored items, one in ten. Only the document formats: a playlist carries
  // an ordered list of things to *play*, and a sponsored line has nothing for a
  // player to open — VLC handed one shows the reader an error, which is the
  // same reason `video/youtube` enclosures are excluded from them.
  //
  // The count is worked out before the fetch rather than after, so a feed too
  // short to carry an ad never pays for the round trip.
  const wanted = spec.media ? 0 : adSlotsFor(items.length);
  const ads = wanted > 0 ? await fetchFeedAds(wanted, { src: 'topic' }) : [];

  const body = buildSyndication(format, channel, interleaveAds(items, ads));

  return new Response(body, {
    headers: {
      'content-type': spec.type,
      'content-disposition': `inline; filename="${filename(
        group ? `${topic.slug}-${group.segment}` : topic.slug,
        format,
      )}"`,
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
    },
  });
}

/**
 * A filename a reader or a player will not be embarrassed by.
 *
 * Matters most for the playlists: a browser handed an `.m3u` saves it to disk,
 * and "download" is a worse name for it than "rssamplifier-jazz.m3u".
 *
 * @param {string} slug
 * @param {string} format
 * @returns {string}
 */
function filename(slug, format) {
  return `rssamplifier-${slug.replace(/[^a-z0-9-]+/gi, '-')}.${format}`;
}

/**
 * An error a caller can read in whichever shape they asked for.
 *
 * A feed reader handed a JSON error where it expected XML reports a parse
 * failure rather than a missing topic, which sends whoever is debugging it to
 * entirely the wrong place — so the response type follows the request.
 *
 * @param {string} format
 * @param {number} status
 * @param {string} error
 * @param {string} hint
 * @returns {Response}
 */
function fail(format, status, error, hint) {
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
