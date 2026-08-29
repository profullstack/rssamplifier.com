/**
 * An RSS document from a bridge, read back as posts.
 *
 * Both unofficial providers publish RSS: RSSHub renders X into a feed, and
 * Teapot (like the Nitter instances before it) does the same. So both need the
 * same conversion, and it lives here rather than twice.
 *
 * **Why convert at all, rather than serving the bridge's XML straight through?**
 * §11 gives five reasons and they are all real, but the load-bearing one is the
 * first: the bridge's `<guid>` is the bridge's, so the day RSSHub goes down and
 * Teapot takes over, every post in every X feed we host changes identity and
 * every subscriber's reader marks the whole timeline unread. Parsing back to a
 * post id and re-keying on `x:<id>` is what makes AC-2 and AC-3 true at the
 * same time.
 *
 * The conversion is lossy in one direction only. A bridge renders a post into
 * prose; there is no way back to the structured post, so `text` here is the
 * rendered text and `media` is what could be read out of the markup. That is
 * enough for every format we publish, and the official provider — which does
 * get structured posts — fills in the rest where it matters.
 */

import { parseFeed } from '@rssamplifier/feed';

import { XUnavailable } from '../errors.js';

/** X post ids are snowflakes; nothing else in a bridge URL looks like one. */
const STATUS_ID = /\/status(?:es)?\/(\d{6,25})/;

/**
 * @param {string} body the RSS document
 * @param {{ provider: string, url: string, fallbackHandle?: string }} ctx
 * @returns {import('../types.js').XFetchResult}
 */
export function postsFromRss(body, ctx) {
  const parsed = parseFeed(body, ctx.url);
  if (!parsed) {
    throw new XUnavailable(`${ctx.provider}: unparseable-response`, { provider: ctx.provider });
  }

  const posts = (parsed.items ?? [])
    .map((item) => toPost(item, ctx))
    .filter(Boolean);

  return {
    posts,
    // The bridge states the account's own name in the channel title, in one of
    // a few shapes: "OpenAI (@OpenAI)", "Twitter @OpenAI", "@OpenAI". Only the
    // display half is wanted, and only when it is not just the handle again.
    displayName: displayNameFrom(parsed.title, ctx.fallbackHandle),
    avatarUrl: parsed.imageUrl ?? null,
  };
}

/**
 * @param {object} item a `parseFeed` item
 * @param {{ provider: string, fallbackHandle?: string }} ctx
 * @returns {import('../types.js').XPost|null}
 */
function toPost(item, ctx) {
  const url = String(item.url ?? '');
  const id = STATUS_ID.exec(url)?.[1] ?? STATUS_ID.exec(String(item.guid ?? ''))?.[1] ?? null;

  // No id, no post. A bridge that emits an item without a status link has given
  // us something that cannot be deduplicated, and an item that cannot be
  // deduplicated arrives again on every crawl for ever — which is worse than
  // dropping it, because it is invisible until the feed is all duplicates.
  if (!id) return null;

  const html = String(item.contentHtml ?? item.summary ?? '');
  const text = toText(html);
  const handle = handleFromUrl(url) ?? ctx.fallbackHandle ?? null;

  // `RT @someone:` is how every bridge in this lineage renders a repost, and it
  // is the only signal available — the rendered feed carries no field for it.
  // Matched at the very start only, so a post *quoting* the string "RT @x" in
  // the middle of a sentence is not mistaken for one.
  const repost = /^RT @([A-Za-z0-9_]{1,15}):\s*/.exec(text);

  return {
    id,
    url: canonicalPostUrl(url, handle, id),
    text: repost ? text.slice(repost[0].length) : text,
    createdAt: item.publishedAt ?? null,
    author: {
      username: handle ?? 'unknown',
      displayName: item.author ? String(item.author).replace(/^@/, '') : undefined,
    },
    replyToId: null,
    quotedPostId: null,
    // A bridge renders a repost inline rather than nesting it, so the original
    // is not separately available. `repostOf` stays null and `normalizeXPost`
    // falls back to the post's own text, which is the original's text — the
    // rendering is right even though the structure is missing.
    repostOfId: repost ? id : null,
    repostOf: null,
    quotedPost: null,
    media: mediaFromHtml(html),
    metrics: undefined,
  };
}

/**
 * The post's address on x.com, not on the bridge.
 *
 * A subscriber clicking through must land on X. Some bridges rewrite links to
 * their own host, and a feed of links into a self-hosted RSSHub is a feed that
 * breaks for everyone the moment that container is retired.
 */
function canonicalPostUrl(url, handle, id) {
  if (/^https:\/\/(?:www\.)?x\.com\//.test(url)) return url;
  return handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`;
}

function handleFromUrl(url) {
  return /^https?:\/\/[^/]+\/([A-Za-z0-9_]{1,15})\/status/.exec(String(url))?.[1] ?? null;
}

/**
 * Images out of rendered markup.
 *
 * Deliberately shallow: `<img src>` and `<video poster>`, and nothing else. A
 * fuller extraction would mean parsing each item's HTML with linkedom, and
 * §24 is explicit that media must never be the thing that fails an ingest —
 * text is primary. A regex that finds most images and never throws is the right
 * trade here in a way it would not be for a document we had to render.
 */
function mediaFromHtml(html) {
  const media = [];

  for (const match of String(html).matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    media.push({ type: 'image', url: decodeEntities(match[1]) });
  }
  for (const match of String(html).matchAll(/<video[^>]+poster=["']([^"']+)["']/gi)) {
    media.push({ type: 'video', url: decodeEntities(match[1]), previewUrl: decodeEntities(match[1]) });
  }

  return media.slice(0, 8);
}

/** Rendered markup back to the prose it was made from. */
function toText(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * @param {string|null|undefined} title
 * @param {string|undefined} handle
 * @returns {string|null}
 */
function displayNameFrom(title, handle) {
  const raw = String(title ?? '').trim();
  if (!raw) return null;

  const paren = /^(.+?)\s*\(@[A-Za-z0-9_]{1,15}\)/.exec(raw);
  const name = (paren ? paren[1] : raw.replace(/^Twitter\s*/i, '').replace(/^@/, '')).trim();

  if (!name) return null;
  if (handle && name.toLowerCase() === handle.toLowerCase()) return null;
  return name;
}
