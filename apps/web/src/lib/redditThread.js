/**
 * One Reddit thread, read live from Arctic Shift for `/r/<sub>/comments/<id>`.
 *
 * Not stored. A thread is a conversation that keeps moving, the crawler stores
 * posts rather than replies, and a comment tree is a few kilobytes that the
 * mirror answers in well under a second. What is kept is a short cache, so a
 * link that gets shared around asks the mirror once a minute rather than once
 * per reader, and a miss so the same junk id is not asked about twice.
 */

import {
  fetchRedditComments,
  fetchRedditPost,
  isShowableRedditPost,
  redditMarkdown,
  redditPostId,
  fetchRedditListing,
  redditPostToItem,
} from '@rssamplifier/social';

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;

/** @type {Map<string, { at: number, value: any }>} */
const cache = new Map();

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}

/**
 * @typedef {{
 *   id: string, subreddit: string, title: string, author: string,
 *   createdAt: string|null, score: number|null, numComments: number,
 *   html: string, link: string|null, domain: string|null, flair: string|null,
 *   redditUrl: string, removed: boolean,
 * }} RedditThreadPost
 */

/**
 * The post and its comments, or `null` when the archive has never seen the id
 * or it belongs to a different subreddit than the URL claims.
 *
 * @param {string} subreddit as it appeared in the URL
 * @param {string} rawId
 * @returns {Promise<{ post: RedditThreadPost, comments: import('@rssamplifier/social').RedditComment[] } | null>}
 */
export async function loadRedditThread(subreddit, rawId) {
  const id = redditPostId(rawId);
  if (!id) return null;

  return cached(`thread:${id}`, async () => {
    const raw = await fetchRedditPost(id);
    if (!raw) return null;
    const comments = await fetchRedditComments(id);
    return { post: threadPost(raw), comments, subreddit: String(raw.subreddit ?? '') };
  }).then((thread) => {
    if (!thread) return null;
    // A post filed under the wrong community is a wrong URL, not a thread.
    if (thread.subreddit.toLowerCase() !== String(subreddit).toLowerCase()) return { moved: thread.post };
    return thread;
  });
}

/**
 * The newest posts of a subreddit, for a page whose row the crawler has not
 * read yet. Same cache, so a busy unread page costs one request a minute.
 *
 * @param {string} name
 * @returns {Promise<Array<object>>} `parseFeed`-shaped items plus `id` and `numComments`
 */
export async function liveSubredditPosts(name) {
  return cached(`listing:${String(name).toLowerCase()}`, async () => {
    const posts = await fetchRedditListing({ mode: 'sub', name: String(name) }, { limit: 30 });
    return posts
      .map((post) => {
        const item = redditPostToItem(post);
        return item ? { ...item, id: String(post.id), numComments: Number(post.num_comments) || 0 } : null;
      })
      .filter(Boolean);
  });
}

/** @returns {RedditThreadPost} */
function threadPost(raw) {
  const removed = !isShowableRedditPost(raw);
  const redditUrl = raw.permalink ? `https://www.reddit.com${raw.permalink}` : `https://www.reddit.com/comments/${raw.id}/`;
  return {
    id: String(raw.id),
    subreddit: String(raw.subreddit ?? ''),
    title: decode(String(raw.title ?? '(untitled)')),
    author: removed ? '[deleted]' : String(raw.author ?? '[deleted]'),
    createdAt: Number(raw.created_utc) > 0 ? new Date(Number(raw.created_utc) * 1000).toISOString() : null,
    score: Number.isFinite(raw.score) ? raw.score : null,
    numComments: Number(raw.num_comments) || 0,
    html: removed ? '' : redditMarkdown(String(raw.selftext ?? '')),
    link: !raw.is_self && raw.url && !removed ? String(raw.url) : null,
    domain: raw.domain ? String(raw.domain) : null,
    flair: raw.link_flair_text ? decode(String(raw.link_flair_text)) : null,
    redditUrl,
    removed,
  };
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** Reddit's URL slug for a title, so our links read like theirs. */
export function threadSlug(title) {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
    .replace(/_+$/, '');
}
