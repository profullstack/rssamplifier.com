import { USER_AGENT } from './list.js';

/**
 * Playlists belonging to channels the directory already indexes.
 *
 * The directory holds 289 YouTube feeds and every one of them is a channel —
 * "everything this person uploaded, newest first". That is the wrong shape for
 * the thing people actually queue. A course is nineteen lectures in order; a
 * conference is a track; an album is a side. All three exist on YouTube as
 * playlists, all three have a feed, and none of them were reachable here.
 *
 * The source deliberately walks channels we already have rather than searching.
 * Somebody already vouched for those channels by putting them in the directory,
 * a playlist on one of them inherits that, and enumerating them costs one
 * request per channel and no API key at all. Sampling 24 of the 289 found
 * playlists on 23 of them.
 *
 * Nothing here is authenticated and nothing here uses the YouTube Data API. The
 * playlists tab is a public page and its markup carries the ids; the feed those
 * ids address is the same public Atom the channel feeds already come from.
 */

/** Longest page body read, so one pathological response cannot exhaust memory. */
const MAX_BYTES = 6_000_000;

/**
 * Channels walked in one pass.
 *
 * The whole set is not walked at once. Each of these pages is about a megabyte,
 * so 289 of them in one run is a quarter of a gigabyte pulled off somebody
 * else's servers in a burst — the behaviour that gets a crawler blocked. A slice
 * per run, rotated, covers everything within a few days and looks like traffic.
 */
export const DEFAULT_BATCH = 40;

/** How many channel pages are in flight at once. */
const CONCURRENCY = 4;

/**
 * Ids that are a view of a channel rather than a work.
 *
 * YouTube reuses the playlist slot for several automatic collections: `UU` is
 * "all uploads", `LL` is the viewer's likes, `FL` a favourites list, and `RD` a
 * generated radio mix that is different every time it is asked for. None is
 * something a person assembled, and the uploads one is the channel feed the
 * directory already has, under a second address.
 */
const REAL_PLAYLIST = /^PL[\w-]{10,}$/;

/**
 * The feed for one playlist.
 *
 * @param {string} playlistId
 * @returns {string}
 */
export function playlistFeedUrl(playlistId) {
  return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;
}

/**
 * The public page listing a channel's playlists.
 *
 * @param {string} channelId
 * @returns {string}
 */
export function channelPlaylistsUrl(channelId) {
  return `https://www.youtube.com/channel/${channelId}/playlists`;
}

/**
 * The channel id inside a YouTube channel feed URL.
 *
 * @param {string} feedUrl
 * @returns {string|null}
 */
export function channelIdFromFeedUrl(feedUrl) {
  const match = String(feedUrl ?? '').match(/[?&]channel_id=(UC[\w-]{10,})/);
  return match ? match[1] : null;
}

/**
 * Playlist ids in a channel's playlists page.
 *
 * Read with a regular expression rather than by walking the parsed
 * `ytInitialData`, because the shape of that object is YouTube's private
 * business and has changed more than once; the id itself is stable, appears
 * under a fixed key, and is trivially validated. Anything not matching a real
 * playlist id is dropped rather than guessed at.
 *
 * The page carries at most 30 before it wants a continuation token, and this
 * does not follow one — 30 playlists from a channel is already more than the
 * directory needs from any single source in one pass.
 *
 * @param {string} html
 * @returns {string[]} distinct playlist ids, in page order
 */
export function parsePlaylistIds(html) {
  const ids = [];
  const seen = new Set();

  for (const match of String(html ?? '').matchAll(/"playlistId":"([\w-]{12,})"/g)) {
    const id = match[1];
    if (seen.has(id) || !REAL_PLAYLIST.test(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

/**
 * Read one channel's playlists.
 *
 * A channel that has been deleted, made private or simply times out returns
 * nothing rather than throwing. One dead channel out of forty must not fail a
 * run and lose the other thirty-nine.
 *
 * @param {string} channelId
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [opts]
 * @returns {Promise<string[]>} playlist ids
 */
export async function channelPlaylists(channelId, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(channelPlaylistsUrl(channelId), {
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
      signal: opts.signal,
    });

    if (!response.ok) return [];

    const body = await response.text();
    if (body.length > MAX_BYTES) return [];

    return parsePlaylistIds(body);
  } catch {
    return [];
  }
}

/**
 * Which slice of the channel list this pass reads.
 *
 * Rotated by run number so consecutive passes cover different channels and the
 * whole set comes round within a few days. Derived rather than stored: the
 * count of previous runs is already recorded, and a cursor column that only
 * this source would use is a schema change to save an arithmetic one.
 *
 * @param {string[]} channels
 * @param {number} runNumber how many times this source has run before
 * @param {number} batch
 * @returns {string[]}
 */
export function rotate(channels, runNumber, batch) {
  if (channels.length === 0 || batch <= 0) return [];
  if (batch >= channels.length) return [...channels];

  const start = (runNumber * batch) % channels.length;
  const slice = channels.slice(start, start + batch);

  // Wrap, so the pass at the end of the list is a full batch rather than the
  // three channels that happened to be left over.
  return slice.length < batch ? [...slice, ...channels.slice(0, batch - slice.length)] : slice;
}

/**
 * Candidate playlist feeds from the channels the directory already holds.
 *
 * @param {{
 *   channels?: string[],
 *   runNumber?: number,
 *   batch?: number,
 *   fetchImpl?: typeof fetch,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} [opts]
 * @returns {Promise<string[]>} playlist feed URLs
 */
export async function youtubePlaylistCandidates(opts = {}) {
  const channels = Array.isArray(opts.channels) ? opts.channels : [];
  const batch = opts.batch ?? DEFAULT_BATCH;
  const pass = rotate(channels, Number(opts.runNumber ?? 0), batch);

  const urls = [];
  const seen = new Set();

  for (let i = 0; i < pass.length; i += CONCURRENCY) {
    const found = await Promise.all(
      pass.slice(i, i + CONCURRENCY).map((channelId) => channelPlaylists(channelId, opts)),
    );

    for (const ids of found) {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        urls.push(playlistFeedUrl(id));
      }
    }

    if (opts.limit && urls.length >= opts.limit) break;
  }

  return opts.limit ? urls.slice(0, opts.limit) : urls;
}
