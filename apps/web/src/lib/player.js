/**
 * The playlists, playable in the browser that asked for them.
 *
 * `/topics/ai/podcasts.m3u` is a correct M3U served with a correct type, and no
 * browser will play it. M3U is not a web format: Chrome, Firefox and Edge all
 * hand the file to the OS or to the downloads shelf, and Safari only parses the
 * `.m3u8` spelling because HLS took the extension. So the one link on the page
 * most obviously labelled "here is something to listen to" is the one link that
 * does nothing when a reader clicks it.
 *
 * The fix is not to stop publishing playlists — a playlist is the whole point of
 * an `.m3u`, and the readers who paste it into a player app get exactly what
 * they came for. It is to notice that a *browser* asked, and give a browser
 * something a browser can play. See `wantsPlayer` for how that is decided, and
 * `/topics/[keyword]/play` for what it is given.
 */

import { laneFor, trackFor } from './queue.js';

/** The query that says "no, really, give me the file." */
const RAW_PARAM = 'dl';

/**
 * Where a topic's player lives.
 *
 * A page of its own rather than a query on the listing, because it is a
 * different thing to arrive at: somebody who opens this wants to press play,
 * not to read a directory of feeds. It is also the redirect target below, and a
 * redirect wants somewhere honest to land.
 *
 * @param {string} slug the topic slug, unencoded
 * @param {string|null} [segment] the sub-group segment, if this is one category
 * @returns {string}
 */
export function playerPath(slug, segment = null) {
  const topic = `/topics/${encodeURIComponent(slug)}`;
  return segment ? `${topic}/${segment}/play` : `${topic}/play`;
}

/**
 * The same address, still as a file, for a reader who wanted the download.
 *
 * @param {string} path the playlist path, e.g. /topics/ai/podcasts.m3u
 * @returns {string}
 */
export function rawPlaylistPath(path) {
  return `${path}?${RAW_PARAM}=1`;
}

/**
 * Is this a browser being navigated to a playlist, rather than a client fetching one?
 *
 * The test is `Sec-Fetch-Dest: document`, and the choice of signal matters more
 * than the rule. Every current browser sends the Sec-Fetch-* headers on a
 * top-level navigation, and nothing else sends them at all: curl, wget, VLC,
 * mpv, every podcast app and every feed reader arrive without them and fall
 * straight through to the file. That is the safe direction to fail in — a
 * subscription that already works keeps working, and only the case that was
 * already broken changes behaviour.
 *
 * `Accept: text/html` was the obvious alternative and is the wrong one. Plenty
 * of players send `Accept: * / *` or no Accept at all, but a handful send a
 * browser-shaped one because they embed a web view, and those would have been
 * handed an HTML page where they expected a playlist — breaking a working
 * subscription to fix a broken click.
 *
 * `?dl=1` opts out, for a reader who genuinely wants the file in their
 * downloads folder rather than in a player. The player page links it.
 *
 * @param {Request} req
 * @returns {boolean}
 */
export function wantsPlayer(req) {
  if (!req) return false;

  // The explicit opt-out wins over everything, including a browser.
  const url = new URL(req.url);
  if (url.searchParams.has(RAW_PARAM)) return false;

  return req.headers.get('sec-fetch-dest') === 'document';
}

/**
 * One row of playable media, as a track the player can queue.
 *
 * Shaped here rather than in the component so that what the page renders and
 * what the `.m3u` carries are drawn from one reading of a row. A track that
 * disagreed with its own playlist entry would be the worst kind of bug to find:
 * the file plays in VLC and not on the site, or the other way round, with
 * nothing in either to explain why.
 *
 * @param {Record<string, unknown>} row a row from q.mediaForTopic
 * @returns {{
 *   id: string,
 *   src: string,
 *   type: string|null,
 *   title: string,
 *   show: string|null,
 *   showHref: string|null,
 *   postHref: string|null,
 *   seconds: number|null,
 * }|null}
 */
export function trackFrom(row) {
  const src = String(row?.audio_url ?? '').trim();
  if (!src) return null;

  const seconds = Number(row?.audio_seconds);

  return {
    // The publisher's guid, for the same reason the feeds use it: our own row
    // ids are renumbered by a re-crawl and React keys should outlive that.
    id: String(row.guid ?? row.url ?? src),
    src,
    type: row.audio_type ? String(row.audio_type) : null,
    title: String(row.title ?? '').trim() || 'Untitled',
    show: row.feed_title ? String(row.feed_title) : null,
    showHref: row.feed_slug ? `/${row.feed_slug}` : null,
    // Where the episode was published, so a listener can go and read the show
    // notes for the thing they are hearing.
    postHref: row.url ? String(row.url) : null,
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
  };
}

/**
 * One playlist row, as both a line of a list and something the dock can carry.
 *
 * The playlist page used to own a player: its own `<audio>`, its own index, its
 * own queue. That player died at the first click, because a component on a page
 * cannot outlive the page — press play on a topic's podcasts, follow any link,
 * and the episode stopped. The transport that *does* survive a navigation is the
 * one in the layout, so the page stops being a player and becomes what it should
 * always have been: a running order to hand the dock.
 *
 * Two shapes come out of one row for the same reason `trackFrom` exists at all.
 * The list needs a duration and a link to the show notes; the dock needs a kind,
 * a poster and a way back to the post. Reading the row twice, in two files,
 * is how they end up disagreeing about what a track is.
 *
 * `dock` is null only for a row with no feed behind it. It used to be null for
 * YouTube and PeerTube too, on the reasoning that the dock had no element for
 * one; the dock carries an embed now — see `dockCarries` in lib/queue.js — and
 * on a video topic that is most of the list, so those rows are queued like any
 * other rather than left behind as bare links.
 *
 * @param {Record<string, unknown>} row a row from q.mediaForTopic
 * @returns {{
 *   id: string, src: string, type: string|null, title: string, show: string|null,
 *   showHref: string|null, postHref: string|null, seconds: number|null,
 *   dock: object|null, lane: string,
 * }|null}
 */
export function playlistEntry(row) {
  const listed = trackFrom(row);
  if (!listed) return null;

  const slug = row?.feed_slug ? String(row.feed_slug) : null;

  return {
    ...listed,
    // Without a feed slug there is no reader page to send the dock's title link
    // to, and a dock entry whose title goes nowhere is worse than a plain link.
    dock: slug ? trackFor(row, { slug, feedTitle: String(row.feed_title ?? '') }) : null,
    lane: laneFor(/** @type {any} */ (row)),
  };
}

/**
 * A duration a person can read at a glance: 1:04:20, or 42:07.
 *
 * @param {unknown} total seconds
 * @returns {string}
 */
export function runtime(total) {
  const seconds = Math.max(0, Math.floor(Number(total) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * How long the whole queue runs, in words, or null when nothing said.
 *
 * Undated and untimed entries are common enough that a total built from a few
 * of them would be a lie told precisely. Only claimed when most of the queue
 * carries a duration.
 *
 * @param {Array<{ seconds: number|null }>} tracks
 * @returns {string|null}
 */
export function queueRuntime(tracks) {
  const timed = tracks.filter((t) => t.seconds);
  if (timed.length < tracks.length / 2) return null;

  const hours = timed.reduce((sum, t) => sum + t.seconds, 0) / 3600;
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`;
}
