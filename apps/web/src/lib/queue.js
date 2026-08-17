import { mediaKind, playableMedia } from './media.js';

/**
 * What a post is for, and what the player can do with it.
 *
 * The queue's lanes and the player's abilities are two different questions and
 * they are answered separately here. A YouTube post belongs in the watch lane —
 * that is what it is for — but nothing outside its own iframe can start it,
 * seek it or hear it end, so the player refuses to pretend and sends the reader
 * to the post instead. Conflating the two is how a queue ends up with a play
 * button that silently does nothing.
 */

/** What each lane is called, in the reader's own words. */
export const LANE_LABEL = { read: 'Read', listen: 'Listen', watch: 'Watch' };

/** The verb on the button that puts a post in that lane. */
export const LANE_VERB = { read: 'Read later', listen: 'Listen later', watch: 'Watch later' };

/**
 * The lane a post belongs in if nobody says otherwise.
 *
 * Read off the enclosure, which is the publisher saying what they published —
 * the same reading the reader page uses to decide how to render the post, so
 * the queue and the page can never disagree about what a thing is.
 *
 * @param {{ audio_url?: unknown, audio_type?: unknown, url?: unknown }} post
 * @returns {'read'|'listen'|'watch'}
 */
export function laneFor(post) {
  const kind = mediaKind(post);
  if (kind === 'audio') return 'listen';
  if (kind) return 'watch';
  return 'read';
}

/**
 * The lanes this post can honestly go in.
 *
 * Read is always on offer, because every post has words somewhere — show notes
 * are worth queueing separately from the episode. Listen and watch are only on
 * offer when there is a file, since there is no text-to-speech here and a
 * "listen later" that can never play is a promise the site cannot keep.
 *
 * @param {{ audio_url?: unknown, audio_type?: unknown, url?: unknown }} post
 * @returns {('read'|'listen'|'watch')[]}
 */
export function lanesOffered(post) {
  const natural = laneFor(post);
  return natural === 'read' ? ['read'] : [natural, 'read'];
}

/**
 * Can the docked player *drive* this — start it, seek it, hear it end?
 *
 * Only for media it holds a real element for. A YouTube or PeerTube post plays
 * in somebody else's iframe, and nothing out here can press its play button,
 * move its needle or be told it finished.
 *
 * @param {string|null} kind
 * @returns {boolean}
 */
export function dockable(kind) {
  return kind === 'audio' || kind === 'video';
}

/**
 * Does this play inside somebody else's frame?
 *
 * @param {string|null} kind
 * @returns {boolean}
 */
export function embedded(kind) {
  return kind === 'youtube' || kind === 'peertube';
}

/**
 * Can the docked player *carry* this — show it, and keep it alive while you browse?
 *
 * A wider question than `dockable`, and the two are kept apart on purpose. The
 * dock used to refuse embeds outright, reasoning that it could not control one;
 * that is true and it was the wrong conclusion. Holding an iframe in the layout
 * still buys the reader the thing the dock exists for — the video keeps playing
 * across every soft navigation on the site — and the topic that prompted this
 * shows why it matters: of the fifty most recent videos under /topics/ai, nine
 * in ten are YouTube or PeerTube. A watch queue that skipped them would be a
 * watch queue over a tenth of the videos.
 *
 * What the dock must not do is *pretend* to drive one. An embed gets no resume
 * after a reload and no automatic advance when it ends, because neither can be
 * known from out here — see DockPlayer, which asks `dockable` again for exactly
 * those two behaviours.
 *
 * @param {string|null} kind
 * @returns {boolean}
 */
export function dockCarries(kind) {
  return dockable(kind) || embedded(kind);
}

/**
 * What the dock needs to play one post and to say what it is playing.
 *
 * Everything is a plain string because this crosses into the client as JSON in
 * a data attribute, and gets stored in sessionStorage so a page load does not
 * cost the reader their place.
 *
 * @param {object} post a feed_items row, or a queue entry joined to one
 * @param {{ slug: string, feedTitle: string, entryId?: string|null }} where
 * @returns {{
 *   src: string, kind: string, type: string|null, title: string, show: string,
 *   href: string, seconds: number|null, image: string|null, entryId: string|null,
 * }|null} null when there is nothing the dock can show
 */
export function trackFor(post, { slug, feedTitle, entryId = null }) {
  const media = playableMedia(post);
  if (!media.src || !dockCarries(media.kind)) return null;

  return {
    src: media.src,
    kind: String(media.kind),
    type: post.audio_type ? String(post.audio_type) : null,
    title: String(post.title ?? 'Untitled'),
    show: String(feedTitle),
    href: `/${slug}/read?p=${encodeURIComponent(String(post.guid))}`,
    seconds: post.audio_seconds ? Number(post.audio_seconds) : null,
    image: post.image_url ? String(post.image_url) : null,
    entryId: entryId ? String(entryId) : null,
  };
}
