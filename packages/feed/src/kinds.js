/**
 * What a feed is, judged by what it carries.
 *
 * Four categories rather than two, because "has audio attached" and "is a
 * podcast" are not the same claim: a netlabel publishing tracks and a show
 * publishing episodes both attach mp3s, and filing the first under podcasts
 * makes the category mean nothing. Video is its own thing again, and on this
 * web it is mostly YouTube channel feeds.
 *
 * They live in their own module because both the feed parser and the playlist
 * parser answer this question, and each one imports the other's helpers.
 */

export const KIND_BLOG = 'blog';
export const KIND_PODCAST = 'podcast';
export const KIND_MUSIC = 'music';
export const KIND_VIDEO = 'video';

/**
 * Something going out now rather than something published.
 *
 * The one category here that RSS genuinely cannot express, which is why it was
 * curated for as long as feeds were the only thing being read. Playlists can
 * say it: an HLS manifest with no `#EXT-X-ENDLIST` is a broadcaster stating
 * that the recording is not finished, and a pls full of icecast URLs with no
 * durations is a radio station. Both are `live` and neither is a guess.
 */
export const KIND_LIVE = 'live';
