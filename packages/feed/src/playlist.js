/**
 * Playlists, read as feeds.
 *
 * `.m3u`, `.m3u8`, `.pls` and `.playlist` are how the parts of the web that
 * never adopted RSS publish a list of things to play: netlabels ship an album
 * as an m3u next to the files, radio stations ship a pls, and a video series
 * ships an m3u of episodes. Each of those is a feed in everything but format —
 * an ordered list of media with titles — and a directory that only speaks XML
 * cannot index any of it.
 *
 * Two things make this more than a line-splitter.
 *
 * The first is that `.m3u8` is two formats wearing one extension. HLS borrowed
 * it for streaming manifests, so an m3u8 is as likely to be a live radio
 * station or a television channel as a list of tracks — and a manifest's lines
 * are not works. They are bitrate variants of one stream, or two-second
 * segments of one stream. Split naively, a half-hour broadcast becomes a
 * "playlist" of nine hundred untitled fragments. So a manifest is read as what
 * it is: one stream, one item, playing at the URL of the manifest itself. See
 * parseHls.
 *
 * The second is that a playlist entry is media without a page. There is no post
 * to link to and no date to sort by, so an entry's URL is its own permalink and
 * its published date is null. That shape is already handled downstream — items
 * sort `nulls last`, and an undated feed costs worthiness points rather than
 * being rejected — but it is why nothing here invents a timestamp.
 */

import { KIND_LIVE, KIND_MUSIC, KIND_VIDEO } from './kinds.js';

/** Extensions that mean the document is a playlist rather than a page. */
const PLAYLIST_EXTENSIONS = ['.m3u', '.m3u8', '.pls', '.playlist'];

/**
 * Content types servers use for the playlist formats.
 *
 * Apple's `vnd.apple.mpegurl` is here even though it is HLS's own type: an HLS
 * manifest is recognised as a playlist and then refused by the parser, which is
 * a better outcome than not recognising it and falling through to the HTML
 * sniffer, where it would look like nothing at all.
 */
const PLAYLIST_TYPES = [
  'audio/x-mpegurl',
  'audio/mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'application/vnd.apple.mpegurl',
  'audio/x-scpls',
  'audio/scpls',
  'application/pls+xml',
];

/** No playlist worth indexing is longer than this, and some are hostile. */
const MAX_ENTRIES = 500;

/**
 * Media file extensions, and what to tell a player about them.
 *
 * The list is the point rather than the completeness: an entry's type decides
 * whether the whole playlist is music or video, and whether the page renders a
 * docked audio transport or a `<video>`.
 */
const MEDIA_TYPES = new Map([
  ['mp3', 'audio/mpeg'],
  ['m4a', 'audio/mp4'],
  ['m4b', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['flac', 'audio/flac'],
  ['wav', 'audio/wav'],
  ['aiff', 'audio/aiff'],
  ['aif', 'audio/aiff'],
  ['wma', 'audio/x-ms-wma'],
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mkv', 'video/x-matroska'],
  ['mov', 'video/quicktime'],
  ['avi', 'video/x-msvideo'],
  ['ogv', 'video/ogg'],
  ['mpg', 'video/mpeg'],
  ['mpeg', 'video/mpeg'],
]);

/**
 * The playlist extension a URL ends in, or '' for anything else.
 *
 * @param {string} url
 * @returns {string}
 */
export function playlistExtension(url) {
  let path;
  try {
    path = new URL(String(url)).pathname.toLowerCase();
  } catch {
    // Not an absolute URL. Fall back to the raw string so a bare filename still
    // answers, which is what tests and CLI callers hand in.
    path = String(url ?? '')
      .toLowerCase()
      .split(/[?#]/)[0];
  }
  return PLAYLIST_EXTENSIONS.find((ext) => path.endsWith(ext)) ?? '';
}

/**
 * Does this document announce itself as a playlist in its first line?
 *
 * Both formats have a header and both are near-universal in the wild: an m3u
 * without `#EXTM3U` carries no titles either, and a pls without `[playlist]` is
 * not a pls.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function hasPlaylistHeader(body) {
  const head = String(body ?? '')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .slice(0, 40)
    .toLowerCase();
  return head.startsWith('#extm3u') || head.startsWith('[playlist]');
}

/**
 * The lines of a document that are neither blank nor a comment.
 *
 * In an m3u these are the entries; in anything else they are whatever the
 * document is made of, which is what makes them worth sniffing.
 *
 * @param {string} body
 * @returns {string[]}
 */
function refLines(body) {
  return String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * Do the first few meaningful lines look like a list of files rather than markup?
 *
 * Only consulted for a URL that already ends in a playlist extension, which is
 * what keeps it this permissive. A simple m3u — the format's original form, one
 * path per line and no header at all — is indistinguishable from a text file
 * otherwise, and plenty of them are still served as `text/plain`.
 *
 * @param {string} body
 * @returns {boolean}
 */
function looksLikeRefList(body) {
  const lines = refLines(body).slice(0, 20);
  if (lines.length === 0) return false;
  // Markup of any kind disqualifies it: an HTML error page served with a 200 is
  // the common false positive here.
  return lines.every((line) => !line.includes('<') && !line.includes('{'));
}

/**
 * Decide whether a fetched response is a playlist.
 *
 * @param {string} contentType
 * @param {string} body
 * @param {string} [url] the URL it was fetched from
 * @returns {boolean}
 */
export function looksLikePlaylist(contentType, body, url = '') {
  const ct = String(contentType ?? '').toLowerCase();
  if (PLAYLIST_TYPES.some((t) => ct.includes(t))) return true;
  if (hasPlaylistHeader(body)) return true;
  return Boolean(playlistExtension(url)) && looksLikeRefList(body);
}

/**
 * Playlists linked from a page, in document order.
 *
 * The standards-based path for a feed is `<link rel="alternate">`; playlists
 * have no equivalent, because nobody ever specified one. They are linked the
 * way a download is — an ordinary `<a href="album.m3u">` next to the tracks —
 * so that is what this reads.
 *
 * Capped, and deliberately low: these are tried only after every real feed
 * candidate has failed, and each one costs an outbound request that a page full
 * of per-track playlists could otherwise multiply without limit.
 *
 * @param {string} html
 * @param {string} baseUrl for resolving relative hrefs
 * @param {number} [limit]
 * @returns {string[]} absolute playlist URLs, deduped
 */
export function findPlaylistLinks(html, baseUrl, limit = 5) {
  if (typeof html !== 'string') return [];
  const out = [];

  const tags = html.match(/<a\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;

    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (!playlistExtension(abs)) continue;
    if (out.includes(abs)) continue;

    out.push(abs);
    if (out.length >= limit) break;
  }

  return out;
}

/**
 * Parse a playlist document into the same shape parseFeed returns.
 *
 * Returns null for anything that is not a playlist of playable media — one
 * listing local files, an empty one, a manifest with no address of its own —
 * so callers can carry on looking for a real feed rather than storing an entry
 * with nothing in it.
 *
 * @param {string} body
 * @param {string} [playlistUrl] used to resolve relative entries
 * @returns {object|null} same shape as parseFeed
 */
export function parsePlaylist(body, playlistUrl = '') {
  if (typeof body !== 'string' || !body.trim()) return null;

  const text = body.replace(/^\uFEFF/, '');

  // A manifest is one stream rather than a list of works, so it does not go
  // through the entry machinery below at all.
  if (isHlsManifest(text)) return parseHls(text, playlistUrl);

  const parsed = /^\s*\[playlist\]/i.test(text)
    ? parsePls(text, playlistUrl)
    : parseM3u(text, playlistUrl);

  if (!parsed || parsed.entries.length === 0) return null;

  const kind = kindOfEntries(parsed.entries);
  const fallbackType = kind === KIND_VIDEO ? 'video/mp4' : 'audio/mpeg';

  const items = parsed.entries.map((entry) => {
    const { title, author } = splitArtist(entry.title, parsed.artist);
    return {
      guid: entry.url,
      // The file is its own permalink: a playlist entry has no post page, and
      // an item that links nowhere reads as broken to every other part of this.
      url: entry.url,
      title,
      summary: '',
      contentHtml: '',
      author,
      publishedAt: null,
      imageUrl: '',
      categories: parsed.genre ? [parsed.genre] : [],
      audio: {
        url: entry.url,
        type: entry.type || fallbackType,
        bytes: null,
        seconds: entry.seconds,
      },
    };
  });

  return {
    // A station's playlist is named after the button that downloaded it —
    // listen.pls, tune-in.m3u — so a live list falls back to its host the same
    // way a manifest does.
    title:
      parsed.title ||
      (kind === KIND_LIVE ? streamTitle(playlistUrl) : titleFromUrl(playlistUrl)) ||
      '(untitled)',
    description: '',
    // A playlist has no home page. Its origin is the one place that is
    // certainly real, which beats inventing a path that may 404.
    siteUrl: origin(playlistUrl),
    language: '',
    imageUrl: parsed.imageUrl,
    categories: parsed.genre ? [parsed.genre] : [],
    kind,
    items,
  };
}

/**
 * Extended M3U, and the plain form it grew out of.
 *
 * The extended directives are all optional and appear in any combination, so
 * each is read where it turns up rather than in a fixed header: `#EXTINF`
 * belongs to the entry that follows it, everything else to the playlist.
 *
 * @param {string} text
 * @param {string} baseUrl
 * @returns {{ entries: object[], title: string, artist: string, genre: string, imageUrl: string }|null}
 */
function parseM3u(text, baseUrl) {
  // The attributes an IPTV list hangs off its `#EXTINF` lines. Nothing in the
  // format declares that its streams are television, but nothing else writes
  // `tvg-logo` either, and it is the only evidence a channel list gives that
  // its entries are worth looking at rather than only listening to.
  const television = /\b(?:tvg-(?:id|name|logo|chno|shift)|group-title)\s*=/i.test(text);

  const entries = [];
  let title = '';
  let artist = '';
  let genre = '';
  let imageUrl = '';
  let pendingTitle = '';
  let pendingSeconds = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const inf = /^#EXTINF\s*:\s*(.*)$/i.exec(line);
      if (inf) {
        const [duration, label] = splitExtinf(inf[1]);
        pendingSeconds = seconds(duration);
        pendingTitle = label;
        continue;
      }

      const directive = /^#(EXT[A-Z]*|PLAYLIST)\s*:\s*(.*)$/i.exec(line);
      if (!directive) continue;
      const name = directive[1].toUpperCase();
      const value = directive[2].trim();

      if (name === 'PLAYLIST' && !title) title = value;
      else if (name === 'EXTALB' && !title) title = value;
      else if (name === 'EXTART' && !artist) artist = value;
      else if (name === 'EXTGENRE' && !genre) genre = value;
      else if (name === 'EXTIMG' && !imageUrl) imageUrl = resolveRef(value, baseUrl) ?? '';
      continue;
    }

    const url = resolveRef(line, baseUrl);
    if (url) {
      entries.push({
        url,
        title: pendingTitle,
        seconds: pendingSeconds,
        type: mediaType(url, television),
      });
    }
    pendingTitle = '';
    pendingSeconds = null;
  }

  return { entries: dedupe(entries), title, artist, genre, imageUrl };
}

/**
 * Is this an HLS manifest rather than a list of separate works?
 *
 * Any `#EXT-X-` tag settles it: the prefix is reserved for the HLS
 * specification's own tags, and a manifest cannot omit them — a master carries
 * `#EXT-X-STREAM-INF` per variant, a media playlist carries
 * `#EXT-X-TARGETDURATION` before its first segment.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isHlsManifest(text) {
  return /^\s*#EXT-X-/im.test(text);
}

/**
 * The MIME type for a stream a reader is meant to hear.
 *
 * Apple's registered type, which is also what Safari and every HLS player
 * expect to be handed.
 */
const HLS_AUDIO = 'application/vnd.apple.mpegurl';

/**
 * …and for one they are meant to watch.
 *
 * Not a registered type. It exists for the same reason `video/youtube` does one
 * module over: everything downstream decides between a `<video>` and a docked
 * `<audio>` by whether the type starts with `video/`, and HLS's own type
 * describes the container rather than what is in it — a television channel and
 * a radio station publish byte-for-byte the same content type. The player
 * never hands this string to the browser; see EpisodePlayer.
 */
const HLS_VIDEO = 'video/vnd.apple.mpegurl';

/** Codecs that mean there are pictures. */
const VIDEO_CODEC = /\b(?:avc1|avc3|hvc1|hev1|dvh1|dvhe|vp0?[89]|av01|mp4v)\b/i;

/**
 * Read an HLS manifest as the one stream it describes.
 *
 * The manifest's own URL is the item: it is what a player is given, it is
 * stable across a broadcast that rewrites its segment list every few seconds,
 * and it is the only address the stream has. Everything inside the document is
 * plumbing.
 *
 * A live stream therefore arrives as a feed of exactly one item, which is
 * honest — there is one thing here to play — and has a deliberate consequence:
 * keyword discovery requires two items, so streams enter the directory by
 * submission, by a human who meant it, rather than by a crawler that found an
 * m3u8 on a CDN.
 *
 * @param {string} text
 * @param {string} url the manifest's own address
 * @returns {object|null}
 */
function parseHls(text, url) {
  // A stream is nothing but its address. Parsed out of a document we cannot
  // name a location for, there is no item to make.
  const stream = resolveRef(url, '');
  if (!stream) return null;

  const video = hasPictures(text);
  const title = streamTitle(stream);
  const runtime = vodSeconds(text);

  return {
    title,
    description: '',
    siteUrl: origin(stream),
    language: '',
    imageUrl: '',
    categories: [],
    // A runtime means `#EXT-X-ENDLIST`, which means the broadcast is over and
    // what is left is a recording — a video or an album, filed like any other.
    // Without one this is still going out, and going out is its own category.
    kind: runtime === null ? KIND_LIVE : video ? KIND_VIDEO : KIND_MUSIC,
    items: [
      {
        guid: stream,
        url: stream,
        title,
        summary: '',
        contentHtml: '',
        author: '',
        publishedAt: null,
        imageUrl: '',
        categories: [],
        audio: {
          url: stream,
          type: video ? HLS_VIDEO : HLS_AUDIO,
          bytes: null,
          seconds: runtime,
        },
      },
    ],
  };
}

/**
 * Does this manifest carry pictures?
 *
 * Positive evidence only, and audio is what its absence means. A master
 * manifest states a resolution or a video codec per variant, and a rendition
 * declares its type outright, so a television channel says so in its own words.
 * A bare media playlist of `.ts` segments says nothing either way, and guessing
 * video there is the more expensive mistake: an audio stream rendered as a
 * video is a black rectangle in the middle of the page, where a video stream
 * rendered as audio is a transport that plays the soundtrack.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasPictures(text) {
  if (/\bRESOLUTION\s*=\s*\d+x\d+/i.test(text)) return true;
  if (/^#EXT-X-MEDIA:[^\n]*\bTYPE\s*=\s*VIDEO\b/im.test(text)) return true;

  for (const codecs of text.matchAll(/\bCODECS\s*=\s*"([^"]*)"/gi)) {
    if (VIDEO_CODEC.test(codecs[1])) return true;
  }

  return false;
}

/**
 * How long a recorded stream runs, or null while it is still going out.
 *
 * `#EXT-X-ENDLIST` is the broadcaster saying the recording is complete, which
 * is what makes the segment durations add up to a runtime. Without it the
 * manifest is a window onto something still happening and any total would be
 * the length of the window.
 *
 * @param {string} text
 * @returns {number|null}
 */
function vodSeconds(text) {
  if (!/^#EXT-X-ENDLIST\b/im.test(text)) return null;

  let total = 0;
  for (const inf of text.matchAll(/^#EXTINF\s*:\s*([\d.]+)/gim)) {
    const n = Number.parseFloat(inf[1]);
    if (Number.isFinite(n) && n > 0) total += n;
  }

  return total > 0 ? Math.floor(total) : null;
}

/**
 * Filenames that name the file's job rather than the stream.
 *
 * Every HLS packager on earth writes one of these, so a directory that took
 * them at face value would list a dozen stations all called "index".
 */
const GENERIC_NAMES = new Set([
  'index',
  'master',
  'playlist',
  'stream',
  'chunklist',
  'live',
  'hls',
  'out',
  'prog_index',
  'manifest',
  'tracks-v1a1',
  // …and the names a station gives the file behind its Listen button.
  'listen',
  'play',
  'tunein',
  'tune-in',
  'radio',
]);

/**
 * What to call a stream that carries no title of its own.
 *
 * HLS has no field for one. The filename is worth trying and usually worthless,
 * so the host is the fallback — "radioparadise.com" is a name a person
 * recognises, and "index" is not.
 *
 * @param {string} url
 * @returns {string}
 */
function streamTitle(url) {
  const name = titleFromUrl(url);
  if (name && !GENERIC_NAMES.has(name.toLowerCase())) return name;

  try {
    return new URL(url).hostname.replace(/^www\./, '') || '(untitled)';
  } catch {
    return '(untitled)';
  }
}

/**
 * PLS: an INI file, and the format every internet radio station hands out.
 *
 * Keys are numbered rather than ordered, and the numbering starts at 1 but is
 * not always contiguous, so entries are collected into a map and sorted.
 *
 * @param {string} text
 * @param {string} baseUrl
 * @returns {{ entries: object[], title: string, artist: string, genre: string, imageUrl: string }|null}
 */
function parsePls(text, baseUrl) {
  const byIndex = new Map();
  const at = (n) => {
    const existing = byIndex.get(n);
    if (existing) return existing;
    const fresh = { url: '', title: '', seconds: null };
    byIndex.set(n, fresh);
    return fresh;
  };

  for (const raw of text.split(/\r?\n/)) {
    const pair = /^\s*(file|title|length)\s*(\d+)\s*=\s*(.*)$/i.exec(raw);
    if (!pair) continue;

    const [, key, index, value] = pair;
    const entry = at(Number(index));
    const trimmed = value.trim();

    if (/^file$/i.test(key)) entry.url = resolveRef(trimmed, baseUrl) ?? '';
    else if (/^title$/i.test(key)) entry.title = trimmed;
    else entry.seconds = seconds(trimmed);
  }

  const entries = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, entry]) => entry)
    .filter((entry) => entry.url)
    .map((entry) => ({ ...entry, type: mediaType(entry.url) }));

  // PLS carries no album, artist or genre of its own.
  return { entries: dedupe(entries), title: '', artist: '', genre: '', imageUrl: '' };
}

/**
 * Split an `#EXTINF` value into its duration and its label.
 *
 * The separator is a comma, and both halves can contain one. Attributes sit
 * between the duration and the separator in an IPTV list — `-1 tvg-id="x"
 * group-title="News, Sport",BBC News` — and a track's own title carries commas
 * as often as any sentence does. Splitting on the first comma breaks the first
 * case and splitting on the last breaks the second, so this splits on the first
 * comma that is not inside quotes, which is right for both.
 *
 * @param {string} value everything after `#EXTINF:`
 * @returns {[string, string]} the duration, then the label
 */
function splitExtinf(value) {
  let quoted = false;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      return [value.slice(0, i), value.slice(i + 1).trim()];
    }
  }

  return [value, ''];
}

/**
 * Turn one line of a playlist into an absolute http(s) URL, or null.
 *
 * Relative entries are normal and correct — a playlist published beside its
 * files refers to them by name — so they resolve against the playlist. What
 * cannot be indexed is dropped: other schemes (`rtsp:`, `mms:`, `file:`) are
 * not fetchable or playable here, and a backslash means the playlist was
 * exported from a desktop player and is listing somebody's hard disk.
 *
 * @param {string} ref
 * @param {string} baseUrl
 * @returns {string|null}
 */
function resolveRef(ref, baseUrl) {
  const raw = String(ref ?? '').trim();
  if (!raw || raw.includes('\\')) return null;

  try {
    const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A duration in seconds, or null when it is missing or means "unknown".
 *
 * Live streams are conventionally `-1`, which is a statement that there is no
 * duration rather than a duration to store.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function seconds(value) {
  const n = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * What to tell a player about a file, judged by its extension.
 *
 * @param {string} url
 * @returns {string} a MIME type, or '' when the extension says nothing
 */
function mediaType(url, television = false) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    path = String(url ?? '');
  }
  const ext = /\.([a-z0-9]{1,5})$/i.exec(path)?.[1]?.toLowerCase();

  // An entry that is itself a manifest is a live stream, which is how both
  // internet radio directories and IPTV lists are published: one `#EXTINF` per
  // station, each pointing at that station's own m3u8. There is nothing in the
  // outer document to say whether a given one carries pictures, so the same
  // reading as everywhere else applies — audio unless the list says otherwise.
  if (ext === 'm3u8' || ext === 'm3u') return television ? HLS_VIDEO : HLS_AUDIO;

  return (ext && MEDIA_TYPES.get(ext)) || '';
}

/**
 * Is this playlist music or a series?
 *
 * Counted over the entries whose type is known, and audio wins ties, because a
 * playlist is an audio format by default and history: the extensions were
 * defined for Winamp and Shoutcast, and video ones remain the minority.
 *
 * Inferring music here is safe in a way that inferring it from an RSS
 * enclosure never was. An mp3 attached to a post is an attachment, and reading
 * it as an album produced 198 feeds of narrated blogs. An m3u *is* the list —
 * there is no post it could be attached to, and assembling one is the only
 * reason the file exists.
 *
 * @param {object[]} entries
 * @returns {string}
 */
function kindOfEntries(entries) {
  let video = 0;
  let audio = 0;
  let live = 0;

  for (const entry of entries) {
    if (isLiveEntry(entry)) live += 1;
    if (entry.type.startsWith('video/')) video += 1;
    else if (entry.type.startsWith('audio/')) audio += 1;
  }

  // Streaming beats the audio-or-video question, because it answers a different
  // one. A list of stations and a list of channels are both places to tune
  // into rather than things to play through, and /lives is where a reader
  // looking for either of them goes. What each stream carries is still recorded
  // on the item, which is what the player reads.
  if (live * 2 > entries.length) return KIND_LIVE;

  return video > audio ? KIND_VIDEO : KIND_MUSIC;
}

/**
 * Is this entry a stream rather than a file?
 *
 * Two shapes, and both are unambiguous in practice. An entry pointing at a
 * manifest is a stream by construction — that is what an IPTV list and a
 * station directory are made of. And an entry with neither a file extension nor
 * a duration is an icecast mount: every radio pls on the web looks like
 * `File1=https://ice.example/station` with `Length1=-1`, because there is no
 * file to name and no end to state.
 *
 * @param {{ type: string, seconds: number|null }} entry
 * @returns {boolean}
 */
function isLiveEntry(entry) {
  if (entry.type === HLS_AUDIO || entry.type === HLS_VIDEO) return true;
  return !entry.type && entry.seconds === null;
}

/**
 * Split "Artist - Title" into its two halves, which is what an m3u title is.
 *
 * Near-universal in the format, and worth reading: a music directory that keeps
 * the artist in the title has no artist. But the same shape spells episode
 * numbering — "S01E02 - The Reveal", "12 - Interlude" — and calling `S01E02` an
 * artist is worse than not splitting at all, so numbering is left alone.
 *
 * An explicit `#EXTART` beats both: the publisher said it, so the title is
 * whatever they wrote and nothing is guessed off it.
 *
 * @param {string} raw the title as the playlist wrote it
 * @param {string} declaredArtist from #EXTART, or ''
 * @returns {{ title: string, author: string }}
 */
function splitArtist(raw, declaredArtist) {
  const text = String(raw ?? '').trim();
  if (declaredArtist) return { title: text, author: declaredArtist };

  const parts = /^(.{1,80}?)\s+-\s+(.+)$/.exec(text);
  if (!parts) return { title: text, author: '' };

  const left = parts[1].trim();
  if (!left || NUMBERING.test(left)) return { title: text, author: '' };

  return { title: parts[2].trim(), author: left };
}

/** Left-hand sides that are a position in the list, not a person. */
const NUMBERING = /^(?:\d+|s\d+\s*e\d+|(?:ep|episode|track|part|no|pt)\.?\s*\d+)$/i;

/**
 * Drop repeats and cap the length.
 *
 * A playlist can list the same file twice and several list the same file two
 * hundred times; the guid is the URL, so a repeat is one row written twice in
 * a single batch and an item count that lies.
 *
 * @param {object[]} entries
 * @returns {object[]}
 */
function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/**
 * A readable title from the playlist's own filename.
 *
 * The fallback for the plain form of the format, which carries no title at all.
 * Underscores become spaces because that is what a filename uses them for.
 *
 * @param {string} url
 * @returns {string}
 */
function titleFromUrl(url) {
  let name = '';
  try {
    const parsed = new URL(url);
    name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    return '';
  }

  const stripped = name.replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  if (!stripped) return '';

  return stripped.replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} url
 * @returns {string}
 */
function origin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
