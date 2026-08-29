/**
 * An X post, written as one of our items.
 *
 * This is the seam the whole feature turns on. Above it, three providers each
 * return posts in whatever shape they happen to speak; below it, nothing in the
 * codebase knows that X exists — the crawler stores these rows, the topic
 * river merges them with blog posts, and `buildSyndication` renders them into
 * RSS, Atom, JSON Feed, Markdown and playlists without a single branch for
 * where they came from (§30, AC-8).
 *
 * The target shape is `parseFeed`'s, not the database's. That is deliberate:
 * `crawlFeed` takes a parsed document, and handing it one means an X source
 * travels the same code path as a blog — dedupe, interval learning, keyword
 * extraction, author credit, FTS indexing — rather than needing its own copy of
 * each. The cost is that this file has to speak camelCase; the alternative is a
 * second ingestion pipeline, which is a far larger cost.
 *
 * Three shapes need care, because each one is a post that is partly about
 * *another* post:
 *
 * - a **repost** carries no text of its own, so an item built from its own
 *   fields is blank. The original's content is rendered under a line naming who
 *   reposted it (§26).
 * - a **quote** is two posts in one item, and both halves have to survive or
 *   the item reads as a non-sequitur (§27).
 * - a **reply** is a post with a parent we may never have seen. It keeps its own
 *   canonical URL and says nothing about what it is replying to (§25).
 */

import { summarize } from '@rssamplifier/feed';

import { xTitle } from './canonical.js';

/** How much of a post becomes its title before an ellipsis. */
const TITLE_CHARS = 110;

/**
 * Turn a provider's posts into a feed document.
 *
 * @param {import('./types.js').XPost[]} posts
 * @param {{
 *   spec: { mode: string, username?: string, query?: string, listId?: string },
 *   url: string,
 *   includeReplies?: boolean,
 *   includeReposts?: boolean,
 *   includeQuotes?: boolean,
 *   displayName?: string|null,
 *   avatarUrl?: string|null,
 * }} context
 * @returns {{ title: string, description: string, siteUrl: string, language: null,
 *   imageUrl: string|null, categories: string[], kind: string, items: object[] }}
 */
export function normalizeXFeed(posts, context) {
  const {
    spec,
    url,
    includeReplies = spec.mode === 'replies',
    includeReposts = true,
    includeQuotes = true,
    displayName = null,
    avatarUrl = null,
  } = context;

  const kept = (Array.isArray(posts) ? posts : []).filter((post) =>
    keep(post, { includeReplies, includeReposts, includeQuotes, mode: spec.mode }),
  );

  // A quoted post that also arrived in its own right is one post, not two
  // (§27). The quote carries the whole of the quoted text already, so the
  // standalone copy is the one to drop — dropping the quote instead would lose
  // the commentary, which is the half somebody followed this account for.
  const quoted = new Set(kept.map((post) => post.quotedPost?.id).filter(Boolean));
  const deduped = kept.filter((post) => !quoted.has(post.id) || post.quotedPostId);

  return {
    title: channelTitle(spec, displayName),
    description: channelDescription(spec, displayName),
    siteUrl: url,
    // X states no language on a timeline, and guessing one from the posts would
    // put a label on the feed that the publisher never claimed.
    language: null,
    imageUrl: avatarUrl ?? null,
    categories: [],
    // A timeline is writing, and `blog` is what this directory calls writing.
    // Not `news`: `isNewsroom` wants two independent signals before it moves a
    // feed out of blogs, and "posts often" is only one of them.
    kind: 'blog',
    items: deduped.map((post) => normalizeXPost(post)).filter(Boolean),
  };
}

/**
 * One post as one item.
 *
 * @param {import('./types.js').XPost} post
 * @returns {object|null}
 */
export function normalizeXPost(post) {
  if (!post?.id) return null;

  const source = post.repostOf ?? post;
  const text = String(source.text ?? '').trim();
  const author = post.author?.username ? `@${post.author.username}` : null;

  return {
    // `x:<postId>`, never the URL (§19). A URL changes when a handle does — X
    // serves /anyone/status/:id for the same post — so a URL-keyed dedupe
    // re-ingests an account's whole timeline the day it renames itself.
    guid: `x:${post.id}`,
    url: post.url ?? postUrl(post),
    title: itemTitle(post, source, text),
    summary: summarize(plainSummary(post, source, text), 400),
    contentHtml: itemHtml(post, source, text),
    author: post.author?.displayName
      ? `${post.author.displayName} (${author})`
      : (author ?? null),
    publishedAt: post.createdAt ?? null,
    // The first image, so a card and a thumbnail have something to show. Video
    // contributes its preview frame rather than nothing.
    imageUrl: firstImage(source) ?? firstImage(post) ?? null,
    categories: hashtags(text),
    // X carries no enclosures. Video exists but it is served from a signed,
    // short-lived URL that no podcast client could still play tomorrow, so
    // nothing is attached and the media is rendered inline instead (§24).
    audio: null,
  };
}

/**
 * Should this post be in the document at all?
 *
 * @param {import('./types.js').XPost} post
 * @param {{ includeReplies: boolean, includeReposts: boolean, includeQuotes: boolean, mode: string }} opts
 * @returns {boolean}
 */
function keep(post, opts) {
  if (!post?.id) return false;

  // The replies *feed* is the one place a reply is the point (§25). Everywhere
  // else the default is off, because an account's replies are mostly one half
  // of a conversation and read as fragments without the other half.
  if (post.replyToId && !opts.includeReplies && opts.mode !== 'replies') return false;
  if (post.repostOfId && !opts.includeReposts) return false;
  if (post.quotedPostId && !opts.includeQuotes) return false;

  return true;
}

/**
 * A title for something that has none.
 *
 * X posts have no titles, and every format we render wants one — a reader's
 * list view is titles and nothing else. So the first line of the post becomes
 * it, prefixed with the handle, which is what §19 specifies and what every
 * other Twitter-to-RSS bridge has converged on for the same reason: in a topic
 * river a bare fragment of prose gives no clue who said it.
 *
 * @param {import('./types.js').XPost} post
 * @param {import('./types.js').XPost} source the reposted original, or the post
 * @param {string} text
 * @returns {string}
 */
function itemTitle(post, source, text) {
  const who = post.author?.username ?? 'x';
  const reposted = post.repostOfId && source.author?.username;

  const body = collapse(text);
  const clipped = body.length > TITLE_CHARS ? `${body.slice(0, TITLE_CHARS).trimEnd()}…` : body;

  if (reposted) {
    return `${who} reposted @${source.author.username}: ${clipped || '(media)'}`;
  }
  return `${who}: ${clipped || '(media)'}`;
}

/**
 * The item's prose, for a summary and for search — media markup excluded, since
 * an `<img>` tag in a search index is noise.
 */
function plainSummary(post, source, text) {
  const parts = [];
  if (post.repostOfId && source.author?.username) {
    parts.push(`Reposted @${source.author.username}:`);
  }
  parts.push(text);

  const quote = post.quotedPost;
  if (quote) {
    const handle = quote.author?.username ? `@${quote.author.username}` : 'a post';
    parts.push(`Quoting ${handle}: ${String(quote.text ?? '').trim()}`);
  }

  return parts.filter(Boolean).join('\n\n');
}

/**
 * The rendered item body.
 *
 * Escaped rather than sanitised, because none of this is markup to begin with:
 * a post is plain text, and the only tags in the output are ones this function
 * wrote. The one exception is a link, which is built from a URL we escape into
 * an href rather than from anything the post supplied as HTML.
 */
function itemHtml(post, source, text) {
  const blocks = [];

  if (post.repostOfId && source.author?.username) {
    blocks.push(
      `<p><em>${escapeHtml(post.author?.username ?? 'They')} reposted ` +
        `<a href="https://x.com/${encodeURIComponent(source.author.username)}">@${escapeHtml(
          source.author.username,
        )}</a>:</em></p>`,
    );
  }

  if (text) blocks.push(`<p>${linkify(text)}</p>`);

  blocks.push(...mediaHtml(source));
  // A repost's own media is the original's, but a quote-with-media carries its
  // own, so both are offered and duplicates are collapsed by the caller's set.
  if (source !== post) blocks.push(...mediaHtml(post));

  const quote = post.quotedPost;
  if (quote) {
    const handle = quote.author?.username;
    const cite = handle
      ? `<a href="https://x.com/${encodeURIComponent(handle)}">@${escapeHtml(handle)}</a>`
      : 'a post';
    const link = quote.url ?? (quote.id ? `https://x.com/i/status/${quote.id}` : null);
    blocks.push(
      '<blockquote>' +
        `<p><strong>${cite}</strong></p>` +
        `<p>${linkify(String(quote.text ?? '').trim())}</p>` +
        mediaHtml(quote).join('') +
        (link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : '') +
        '</blockquote>',
    );
  }

  return blocks.join('\n') || '<p>(no text)</p>';
}

/**
 * Images and video previews, as markup a reader will actually render.
 *
 * Video gets its poster frame wrapped in a link to the post rather than a
 * `<video>` element: the direct media URL X hands out is signed and expires, so
 * an embedded player in a subscriber's reader is a broken player within the
 * hour. A still that links to the post keeps working for as long as the post
 * does. Media extraction failing takes nothing with it — text is primary (§24).
 */
function mediaHtml(post) {
  const media = Array.isArray(post?.media) ? post.media : [];

  return media
    .map((entry) => {
      const src = entry?.previewUrl ?? entry?.url;
      if (!src || typeof src !== 'string') return null;

      const img = `<img src="${escapeHtml(src)}" alt="" loading="lazy">`;
      if (entry.type === 'image') return `<p>${img}</p>`;

      const href = post.url ?? (post.id ? `https://x.com/i/status/${post.id}` : null);
      const label = entry.type === 'gif' ? 'GIF' : 'Video';
      return href
        ? `<p><a href="${escapeHtml(href)}">${img}<br>▶ ${label} on X</a></p>`
        : `<p>${img}</p>`;
    })
    .filter(Boolean);
}

/** `#tags` as categories, which is the closest thing a post has to one. */
function hashtags(text) {
  const found = String(text ?? '').match(/(?:^|\s)#([A-Za-z][A-Za-z0-9_]{1,49})/g) ?? [];
  return [...new Set(found.map((tag) => tag.trim().slice(1)))].slice(0, 12);
}

/** The first still image the post can offer. */
function firstImage(post) {
  const media = Array.isArray(post?.media) ? post.media : [];
  for (const entry of media) {
    const src = entry?.type === 'image' ? entry.url : entry?.previewUrl;
    if (typeof src === 'string' && src) return src;
  }
  return null;
}

function postUrl(post) {
  const handle = post.author?.username;
  return handle
    ? `https://x.com/${handle}/status/${post.id}`
    : `https://x.com/i/status/${post.id}`;
}

function channelTitle(spec, displayName) {
  if (displayName && spec.username) {
    if (spec.mode === 'replies') return `${displayName} (@${spec.username}) — replies`;
    if (spec.mode === 'media') return `${displayName} (@${spec.username}) — media`;
    return `${displayName} (@${spec.username})`;
  }
  return xTitle(spec);
}

function channelDescription(spec, displayName) {
  const who = displayName ?? (spec.username ? `@${spec.username}` : null);
  switch (spec.mode) {
    case 'user':
      return `Posts from ${who} on X, mirrored by RSS Amplifier.`;
    case 'replies':
      return `Posts and replies from ${who} on X, mirrored by RSS Amplifier.`;
    case 'media':
      return `Photos and video from ${who} on X, mirrored by RSS Amplifier.`;
    case 'search':
      return `X posts matching ${spec.query}, mirrored by RSS Amplifier.`;
    case 'list':
      return `Posts from X list ${spec.listId}, mirrored by RSS Amplifier.`;
    default:
      return 'X posts mirrored by RSS Amplifier.';
  }
}

/** Whitespace as one space, so a title made from a multi-line post reads. */
function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Bare URLs, @handles and #tags as links, everything else escaped.
 *
 * One pass rather than three, because escaping after linkifying would escape
 * the tags this function just wrote, and linkifying after escaping would have
 * to match against `&amp;` inside URLs. Splitting on the pattern and escaping
 * each side of every match avoids both.
 */
function linkify(text) {
  const raw = String(text ?? '');
  const pattern = /(https?:\/\/[^\s<]+|(?<![\w@])@[A-Za-z0-9_]{1,15}|(?<![\w#])#[A-Za-z][A-Za-z0-9_]{1,49})/g;

  let out = '';
  let last = 0;

  for (const match of raw.matchAll(pattern)) {
    const token = match[0];
    const at = match.index ?? 0;
    out += escapeHtml(raw.slice(last, at)).replace(/\n/g, '<br>');
    last = at + token.length;

    if (token.startsWith('http')) {
      // A trailing `.` or `)` is almost always the sentence, not the URL.
      const trimmed = token.replace(/[.,;:!?)\]]+$/, '');
      const tail = token.slice(trimmed.length);
      out += `<a href="${escapeHtml(trimmed)}" rel="nofollow">${escapeHtml(trimmed)}</a>${escapeHtml(tail)}`;
    } else if (token.startsWith('@')) {
      const handle = token.slice(1);
      out += `<a href="https://x.com/${encodeURIComponent(handle)}">${escapeHtml(token)}</a>`;
    } else {
      const tag = token.slice(1);
      out += `<a href="https://x.com/hashtag/${encodeURIComponent(tag)}">${escapeHtml(token)}</a>`;
    }
  }

  out += escapeHtml(raw.slice(last)).replace(/\n/g, '<br>');
  return out;
}

/** @param {string} value */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
