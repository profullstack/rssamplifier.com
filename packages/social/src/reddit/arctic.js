/**
 * Reddit, read through Arctic Shift rather than from reddit.com.
 *
 * Reddit answers a datacenter address with a 403 or a hang as often as with a
 * feed: on 2026-10-06, 36,679 of the directory's 50,030 subreddits had never
 * been read once, and 1,537 more were failing on timeouts. Arctic Shift
 * (https://arctic-shift.photon-reddit.com) archives Reddit as it is posted and
 * serves it as JSON to anyone, which is the same bargain RSSHub is for X: a
 * public mirror that is built to be asked.
 *
 * Everything that talks to it lives in this file, so swapping the mirror is one
 * edit. The item shape is `parseFeed`'s, and the guid is Reddit's own fullname
 * (`t3_<id>`), which is exactly what Reddit's Atom feed used as `<id>` — the
 * 125k items already collected the old way keep their identity, and switching
 * the method marks nothing unread.
 */

import { summarize } from '@rssamplifier/feed';

import { providerGet } from '../x/providers/http.js';
import { XUnavailable } from '../x/errors.js';

export const ARCTIC_BASE = 'https://arctic-shift.photon-reddit.com';

/** Reddit post ids are base-36, currently seven characters. */
const POST_ID = /^[a-z0-9]{4,12}$/;

/** How many posts one crawl asks for; Reddit's own RSS returned 25. */
export const LISTING_LIMIT = 50;

/**
 * Is this a Reddit post id we will ask about? Accepts the `t3_` fullname too.
 *
 * @param {unknown} input
 * @returns {string|null} the bare id, lowercased
 */
export function redditPostId(input) {
  const id = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^t3_/, '');
  return POST_ID.test(id) ? id : null;
}

/**
 * GET one Arctic Shift endpoint and hand back its `data`.
 *
 * @param {string} path e.g. `/api/posts/search`
 * @param {Record<string, string|number>} params
 * @param {{ env?: Record<string, string|undefined>, fetch?: typeof fetch, signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<any>}
 */
export async function arcticGet(path, params, opts = {}) {
  const env = opts.env ?? process.env;
  const base = String(env.ARCTIC_SHIFT_BASE_URL || ARCTIC_BASE).replace(/\/+$/, '');
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const { body } = await providerGet(url, {
    provider: 'arctic-shift',
    headers: { accept: 'application/json' },
    timeoutMs: opts.timeoutMs ?? (Number(env.ARCTIC_SHIFT_TIMEOUT_MS) || undefined),
    fetch: opts.fetch,
    signal: opts.signal,
  });

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new XUnavailable('arctic-shift: unparseable-response');
  }
  // Arctic Shift reports a bad query as a 200 or 400 with `{ error }`; either
  // way it is a fault in the request or the mirror, never news about the source.
  if (json?.error) throw new XUnavailable(`arctic-shift: ${String(json.error).slice(0, 120)}`);
  return json?.data ?? null;
}

/**
 * The newest posts of a subreddit or a user, newest first.
 *
 * @param {{ mode: 'sub'|'user', name: string }} spec
 * @param {Parameters<typeof arcticGet>[2] & { limit?: number }} [opts]
 * @returns {Promise<object[]>} raw Reddit post objects
 */
export async function fetchRedditListing(spec, opts = {}) {
  const key = spec.mode === 'user' ? 'author' : 'subreddit';
  const data = await arcticGet(
    '/api/posts/search',
    { [key]: spec.name, sort: 'desc', limit: opts.limit ?? LISTING_LIMIT },
    opts,
  );
  return Array.isArray(data) ? data : [];
}

/**
 * One post by id, or null when the archive has never seen it.
 *
 * @param {string} id
 * @param {Parameters<typeof arcticGet>[2]} [opts]
 * @returns {Promise<object|null>}
 */
export async function fetchRedditPost(id, opts = {}) {
  const bare = redditPostId(id);
  if (!bare) return null;
  const data = await arcticGet('/api/posts/ids', { ids: bare }, opts);
  return Array.isArray(data) && data[0] ? data[0] : null;
}

/**
 * A post's comments as a tree.
 *
 * @param {string} id
 * @param {Parameters<typeof arcticGet>[2] & { limit?: number }} [opts]
 * @returns {Promise<RedditComment[]>}
 */
export async function fetchRedditComments(id, opts = {}) {
  const bare = redditPostId(id);
  if (!bare) return [];
  const data = await arcticGet('/api/comments/tree', { link_id: bare, limit: opts.limit ?? 500 }, opts);
  return commentTree(Array.isArray(data) ? data : []);
}

/**
 * @typedef {{
 *   id: string, author: string, createdAt: string|null, score: number|null,
 *   html: string, removed: boolean, submitter: boolean, replies: RedditComment[]
 * }} RedditComment
 */

/**
 * Reddit's `t1` listing, reduced to what a page shows.
 *
 * A removed or deleted comment keeps its place, because its replies are still
 * answers to something, but loses its words: what a moderator or the author
 * took down is not ours to republish.
 *
 * @param {any[]} nodes
 * @returns {RedditComment[]}
 */
export function commentTree(nodes) {
  const out = [];
  for (const node of nodes ?? []) {
    if (node?.kind !== 't1' || !node.data) continue;
    const c = node.data;
    const body = String(c.body ?? '');
    const removed =
      body === '[removed]' || body === '[deleted]' || Boolean(c._meta?.removal_type) || c.author === '[deleted]';
    const replies = c.replies && typeof c.replies === 'object' ? (c.replies.data?.children ?? []) : [];
    out.push({
      id: String(c.id),
      author: removed ? '[deleted]' : String(c.author ?? '[deleted]'),
      createdAt: isoFromUnix(c.created_utc),
      score: Number.isFinite(c.score) ? c.score : null,
      html: removed ? '' : redditMarkdown(body),
      removed,
      submitter: Boolean(c.is_submitter),
      replies: commentTree(replies),
    });
  }
  return out;
}

/**
 * Is this post one we may show? Removed and deleted posts are skipped whole.
 *
 * @param {any} post
 */
export function isShowable(post) {
  if (!post?.id || !post.title) return false;
  if (post.removed_by_category) return false;
  const text = String(post.selftext ?? '');
  return text !== '[removed]' && text !== '[deleted]';
}

/**
 * One Reddit post as a `parseFeed` item.
 *
 * @param {any} post a raw Reddit post object
 * @returns {object|null}
 */
export function postToItem(post) {
  if (!isShowable(post)) return null;

  const url = post.permalink
    ? `https://www.reddit.com${post.permalink}`
    : `https://www.reddit.com/comments/${post.id}/`;
  const image = postImage(post);

  const parts = [];
  if (post.selftext) parts.push(redditMarkdown(String(post.selftext)));
  if (!post.is_self && post.url) {
    if (image) parts.push(`<p><img src="${attr(image)}" alt=""></p>`);
    parts.push(`<p><a href="${attr(post.url)}">${escapeHtml(post.domain || post.url)}</a></p>`);
  }
  parts.push(
    `<p>submitted by <a href="https://www.reddit.com/user/${attr(post.author)}">u/${escapeHtml(post.author)}</a>` +
      ` · <a href="${attr(url)}">${Number(post.num_comments) || 0} comments</a></p>`,
  );
  const contentHtml = parts.join('\n');

  return {
    guid: `t3_${post.id}`,
    url,
    title: decodeEntities(String(post.title)),
    // From the post's own words only. A bare link or an empty text post has no
    // gist, and the "submitted by" footer is not one: it would repeat the byline.
    summary: post.selftext ? summarize(redditMarkdown(String(post.selftext))) : post.is_self ? '' : String(post.domain ?? ''),
    contentHtml,
    author: `u/${post.author}`,
    publishedAt: isoFromUnix(post.created_utc),
    imageUrl: image,
    categories: post.link_flair_text ? [decodeEntities(String(post.link_flair_text))] : [],
    audio: null,
  };
}

/** A picture worth showing, from the preview Reddit generated or the link itself. */
function postImage(post) {
  const preview = post?.preview?.images?.[0]?.source?.url;
  if (preview) return decodeEntities(String(preview));
  if (post?.post_hint === 'image' && /^https:\/\//.test(String(post.url))) return String(post.url);
  const thumb = String(post?.thumbnail ?? '');
  return /^https:\/\//.test(thumb) ? thumb : null;
}

function isoFromUnix(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

/* ------------------------------------------------------------- markdown -- */

/**
 * Reddit's markdown, as the small HTML subset a reader needs.
 *
 * Deliberately not a full CommonMark implementation: paragraphs, line breaks,
 * quotes, lists, code, emphasis and links cover nearly every post, and what is
 * left over reads fine as text. The output is escaped here and sanitised again
 * wherever it is rendered, so a construct this misses degrades to visible
 * punctuation, never to markup.
 *
 * Reddit stores `&`, `<` and `>` entity-escaped in `selftext` and `body`, so
 * those are decoded first, then everything is escaped once.
 *
 * @param {string} md
 * @returns {string}
 */
export function redditMarkdown(md) {
  const text = decodeEntities(String(md ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/​/g, '')
    .trim();
  if (!text) return '';

  const blocks = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // Fenced or four-space-indented code.
    if (/^```/.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      blocks.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^( {4}|\t)/.test(line)) {
      const body = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || /^\s*$/.test(lines[i]))) {
        body.push(lines[i++].replace(/^( {4}|\t)/, ''));
      }
      blocks.push(`<pre><code>${escapeHtml(body.join('\n').trimEnd())}</code></pre>`);
      continue;
    }

    if (/^>/.test(line)) {
      const body = [];
      while (i < lines.length && /^>/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(`<blockquote>${redditMarkdown(escapeEntities(body.join('\n')))}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items = [];
      while (i < lines.length && marker.test(lines[i])) items.push(lines[i++].replace(marker, ''));
      const tag = ordered ? 'ol' : 'ul';
      blocks.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(`<p><strong>${inline(heading[2])}</strong></p>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push('<hr>');
      i += 1;
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(```|>|( {4}|\t))/.test(lines[i]) &&
      !bullet.test(lines[i]) &&
      !numbered.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    blocks.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }

  return blocks.join('\n');
}

/** Links, code spans and emphasis inside one line, escaping everything else. */
function inline(raw) {
  const tokens = [];
  const keep = (html) => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };

  let s = String(raw);
  s = s.replace(/`([^`]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) =>
    keep(`<a href="${attr(href)}">${escapeHtml(label)}</a>`),
  );
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])/g, (_, lead, href) =>
    `${lead}${keep(`<a href="${attr(href)}">${escapeHtml(href)}</a>`)}`,
  );
  s = s.replace(/(^|[\s(])\/?(r|u)\/([A-Za-z0-9_-]{3,21})\b/g, (_, lead, kind, name) =>
    `${lead}${keep(`<a href="https://www.reddit.com/${kind}/${attr(name)}">${kind}/${escapeHtml(name)}</a>`)}`,
  );

  s = escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)]);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

/** Re-escape for a recursive pass, which decodes on entry. */
function escapeEntities(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x200B;/gi, '')
    .replace(/&amp;/g, '&');
}
