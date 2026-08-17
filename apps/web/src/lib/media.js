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
 * Three kinds because they are shown three ways — a YouTube embed, a `<video>`,
 * a docked `<audio>` — and one more for the ordinary case of a post that is
 * just a post.
 *
 * @param {{ audio_url?: unknown, audio_type?: unknown }} post
 * @returns {'youtube'|'video'|'audio'|null}
 */
export function mediaKind(post) {
  if (!post?.audio_url) return null;

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
 * Is the post something to watch rather than something to read?
 *
 * @param {{ audio_url?: unknown, audio_type?: unknown }} post
 * @returns {boolean}
 */
export function isWatchable(post) {
  const kind = mediaKind(post);
  return kind === 'youtube' || kind === 'video';
}
