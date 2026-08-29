/**
 * What kind of thing a post actually is.
 *
 * A feed item carries an enclosure or it does not, and when it does, the
 * enclosure's MIME type is the publisher saying what they published. That is a
 * better answer than anything the reader can infer from the page: YouTube's
 * watch page refuses to be framed, so a video read as "a page" becomes a
 * refusal notice over a link out, while the same post read as "a video" is a
 * player with the video in it.
 *
 * Four kinds because they are shown four ways — a YouTube embed, a PeerTube
 * embed, a `<video>`, a docked `<audio>` — and one more for the ordinary case
 * of a post that is just a post.
 *
 * @param {{ audio_url?: unknown, audio_type?: unknown, url?: unknown }} post
 * @returns {'youtube'|'peertube'|'video'|'audio'|null}
 */
export function mediaKind(post) {
  if (!post?.audio_url) return null;

  // Before the MIME type, because a PeerTube enclosure lies about what it is
  // useful for: it says video/mp4 and points at a download endpoint. See
  // peertubeEmbed below.
  if (peertubeEmbed(post)) return 'peertube';

  const type = String(post.audio_type ?? '').toLowerCase();

  // The type feed parsing assigns a YouTube enclosure. It is not a real MIME
  // type and no player can be handed the URL directly — only the embed works.
  if (type === 'video/youtube') return 'youtube';
  if (type.startsWith('video/')) return 'video';

  // An enclosure with no type, or a type nothing here knows, is treated as
  // audio: podcast feeds are most of what carries an enclosure at all, and a
  // docked audio transport is the harmless guess — it either plays or shows the
  // browser's own "cannot play" control, where guessing video would put a black
  // rectangle in the middle of the page.
  return 'audio';
}

/**
 * Is this a live stream rather than a file?
 *
 * HLS manifests arrive from playlist parsing, where a whole broadcast is stored
 * as one item playing at the manifest's URL. Worth telling apart from a file
 * for two reasons: a stream has no length and nothing to download, and its
 * content type is one no browser will admit to supporting if it is asked in
 * advance — Safari plays HLS but answers `canPlayType` with an empty string, so
 * a `<source type>` carrying it is a source the player skips.
 *
 * @param {unknown} type
 * @returns {boolean}
 */
export function isStream(type) {
  return /vnd\.apple\.mpegurl|x-mpegurl|mpegurl/i.test(String(type ?? ''));
}

/**
 * Is the post something to watch rather than something to read?
 *
 * @param {{ audio_url?: unknown, audio_type?: unknown, url?: unknown }} post
 * @returns {boolean}
 */
export function isWatchable(post) {
  const kind = mediaKind(post);
  return kind === 'youtube' || kind === 'peertube' || kind === 'video';
}

/**
 * Longer than this and the post is an article the media was attached to.
 *
 * Matches ARTICLE_TEXT in packages/feed/src/parse.js, which draws the same line
 * one level up to decide what a whole feed is. Deliberately the same number:
 * the two answers disagreeing is how a feed lands under /videos while its posts
 * render as articles.
 */
const ARTICLE_TEXT = 1200;

/**
 * Is the media the post, or a file attached to one?
 *
 * `isWatchable` answers "is there a video to play", which is a question about
 * the enclosure. This is the different question of whether the video is what
 * the reader came for — and the two were conflated, so a post with a video on
 * it was rendered as an episode: player, excerpt, "Watch on ↗", and the article
 * the feed had shipped in full silently dropped. 1,369 posts in the directory
 * carry both a video enclosure and a real article body; every one of them was
 * being served with the article missing.
 *
 * Measured on the body rather than on the enclosure because that is the actual
 * distinction. A show's notes are a paragraph; an article is an article.
 *
 * @param {{ audio_url?: unknown, audio_type?: unknown, url?: unknown }} post
 * @param {unknown} contentHtml the post's own body, as the feed shipped it
 * @returns {boolean}
 */
export function isEpisode(post, contentHtml, contentChars = null) {
  if (!mediaKind(post)) return false;

  // The stored count first, the body second. Bodies stopped being stored at
  // crawl time in 0031 -- they were 10 GB of a 14 GB database -- so for
  // anything crawled since, `contentHtml` is null and measuring it would return
  // 0 and call every podcast-shaped post an episode. The crawl now records the
  // length instead, which is the only thing this function ever wanted from it.
  // Rows that predate the change still carry their body and are measured
  // directly.
  // Tested for null explicitly rather than through Number(), because
  // `Number(null)` is 0 and `Number.isFinite(0)` is true -- so the obvious
  // spelling accepts "no count" as "a body of zero length" and calls every post
  // with media an episode. Written that way first; two tests caught it.
  const known = contentChars !== null && contentChars !== undefined && Number.isFinite(Number(contentChars));
  const chars = known ? Number(contentChars) : textLength(contentHtml);

  return chars < ARTICLE_TEXT;
}

/**
 * Is the picture the post, rather than an illustration in one?
 *
 * Asked so the reader knows whether to hold a body to the prose measure or let
 * its pictures out to the size they were published at. A photograph inside a
 * two-thousand-word essay is an illustration and belongs in the column with
 * everything else; a comic strip with a line under it is a picture, and 42rem
 * is not a fact about it.
 *
 * Same test `isEpisode` makes about audio and video, on the same number and for
 * the same reason: the words either are the post or are a caption on it, and
 * their length is what says which. A body with no picture in it is not a
 * picture post however short it is — a one-line note is still prose.
 *
 * @param {unknown} html the body, as it will be rendered
 * @returns {boolean}
 */
export function isPicture(html) {
  const body = String(html ?? '');
  if (!/<(?:img|figure|picture)\b/i.test(body)) return false;
  return textLength(body) < ARTICLE_TEXT;
}

/**
 * How much prose some HTML carries, in characters.
 *
 * @param {unknown} html
 * @returns {number}
 */
function textLength(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/**
 * PeerTube's embed URL for a post, if that is what the post is.
 *
 * The enclosure a PeerTube feed publishes is not something to hand a `<video>`
 * element. It points at `/download/videos/generate/<uuid>?videoFileIds=<n>`,
 * and measured against two live instances that endpoint is:
 *
 *   - not durable — `videoFileIds` names a particular encoded file, so it stops
 *     resolving when the instance re-encodes or prunes. video.tedomum.net
 *     answers 404 for the id in its own current feed.
 *   - not streamable even when it answers — peertube.hackerfoo.com returns 200
 *     with `content-disposition: attachment` and no `accept-ranges`, which is a
 *     download, not a source a player can seek.
 *
 * The embed is keyed on the short id in the permalink instead, so it survives
 * everything the file ids do not, and it is a real player rather than a bare
 * file. Same conclusion as YouTube, arrived at from the opposite direction:
 * there the watch page refuses framing, here the file refuses to behave like
 * one.
 *
 * Recognised on the permalink rather than on the enclosure: `/w/<id>` is
 * PeerTube's canonical watch path and `/videos/watch/<uuid>` its older one. The
 * enclosure must be a video on the same host, which is what keeps an ordinary
 * blog that happens to use `/w/` out of this branch.
 *
 * @param {{ audio_url?: unknown, audio_type?: unknown, url?: unknown }} post
 * @returns {string|null}
 */
export function peertubeEmbed(post) {
  const type = String(post?.audio_type ?? '').toLowerCase();
  if (!type.startsWith('video/') || type === 'video/youtube') return null;

  let watch;
  let media;
  try {
    watch = new URL(String(post?.url ?? ''));
    media = new URL(String(post?.audio_url ?? ''));
  } catch {
    return null;
  }

  if (watch.protocol !== 'https:' && watch.protocol !== 'http:') return null;
  if (watch.hostname !== media.hostname) return null;

  const match =
    watch.pathname.match(/^\/w\/([\w-]{6,})\/?$/) ??
    watch.pathname.match(/^\/videos\/watch\/([\w-]{6,})\/?$/);
  if (!match) return null;

  return `${watch.origin}/videos/embed/${match[1]}`;
}

/**
 * The URL to hand the player, which is not always the enclosure.
 *
 * @param {{ audio_url?: unknown, audio_type?: unknown, url?: unknown }} post
 * @returns {{ kind: 'youtube'|'peertube'|'video'|'audio'|null, src: string|null }}
 */
export function playableMedia(post) {
  const kind = mediaKind(post);
  if (!kind) return { kind: null, src: null };

  return {
    kind,
    src: secureMedia(kind === 'peertube' ? peertubeEmbed(post) : String(post.audio_url)),
  };
}

/**
 * The enclosure over TLS, because over plain http it does not play at all.
 *
 * A player is a subresource of a page served from https, so an http source is
 * mixed content: the browser blocks it, and our own `media-src` lists https
 * only, so it never even gets that far. The reader saw a transport with a
 * dead play button and no explanation — the enclosure was fine, the scheme
 * was not.
 *
 * Upgrading is the only move that can work here. There is no version of this
 * where http plays: allowing it in the policy would not help, since a browser
 * blocks mixed media whatever the policy says. A host without TLS is no worse
 * off than before — the player was already blocked — and the large majority of
 * feeds still printing http:// enclosures are served by hosts that have had
 * certificates for years.
 *
 * @param {string|null} src
 * @returns {string|null}
 */
function secureMedia(src) {
  if (!src) return null;
  return src.startsWith('http://') ? `https://${src.slice('http://'.length)}` : src;
}
