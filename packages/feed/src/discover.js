/**
 * Feed discovery: people submit "myblog.com", not "myblog.com/feed.xml".
 * Turning the former into the latter is most of what makes submission painless.
 *
 * The mechanics live in @profullstack/submit-feed now, extracted from here so
 * p0dcasters.com and any later directory take feeds the same way: the URL
 * gate that refuses markup-as-hostname (the 3,700 rows of `https://version="1.0"/`
 * that the browser scanner once pushed in), the <link rel="alternate"> walk,
 * the conventional paths, and the body sniff. This module is the seam: the
 * same names, so nothing in the workspace changed its imports, plus the one
 * thing this directory does that the package does not, which is to admit a
 * playlist as a feed.
 */

import {
  normalizeUrl,
  findFeedLinks,
  guessFeedUrls,
  looksLikeFeed as looksLikeFeedDocument,
} from '@profullstack/submit-feed/core';
import { looksLikePlaylist } from './playlist.js';

export { normalizeUrl, findFeedLinks, guessFeedUrls };

/**
 * Decide whether a fetched response looks like a feed.
 *
 * A playlist is a feed here -- a list of media with titles -- so it is admitted
 * on the same footing rather than sniffed for afterwards. Everything else is
 * the shared sniff: content type first, then the head of the body, because
 * plenty of feeds are served as text/plain or text/html.
 *
 * @param {string} contentType
 * @param {string} body
 * @param {string} [url] the URL it came from, which is the only thing that
 *   identifies the plain form of an m3u
 * @returns {boolean}
 */
export function looksLikeFeed(contentType, body, url = '') {
  if (looksLikePlaylist(contentType, body, url)) return true;
  return looksLikeFeedDocument(contentType, body);
}
