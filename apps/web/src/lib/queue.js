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
 * Can the docked player carry this itself?
 *
 * Only for media it holds an element for. A YouTube or PeerTube post plays in
 * somebody else's iframe: it cannot be started from outside, cannot report that
 * it finished, and cannot be resumed at a position after a page load — so the
 * dock never claims it.
 *
 * @param {string|null} kind
 * @returns {boolean}
 */
export function dockable(kind) {
  return kind === 'audio' || kind === 'video';
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
 * }|null} null when there is nothing the dock can play
 */
export function trackFor(post, { slug, feedTitle, entryId = null }) {
  const media = playableMedia(post);
  if (!media.src || !dockable(media.kind)) return null;

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
