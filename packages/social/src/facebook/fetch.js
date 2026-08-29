/**
 * Collecting Facebook, by session first and by API where one is available.
 *
 * Two ways in, and the better one is not the default because it is almost never
 * possible. Meta's Graph API returns a Page's posts only to somebody who
 * administers that Page — reading anyone else's needs `Page Public Content
 * Access`, which wants App Review and business verification — so a token
 * reaches a handful of Pages and a session reaches the rest. `FB_PAGE_TOKENS`
 * is consulted first and `FB_COOKIE` carries everything else.
 *
 * Both produce the same items, keyed the same way (`fb:<post id>`), so a Page
 * that gains a token later does not change identity and nobody's reader marks
 * the feed unread.
 *
 * **Credentials live in the environment, never in a table**, for the reason X's
 * session cookies do not: a Page token can post as the Page, and a Facebook
 * session cookie is a login to somebody's account. See §36 and AC-7.
 *
 * On what this is worth, and the failure handling that follows from it, see
 * `./scrape.js`.
 */

import { providerGet } from '../x/providers/http.js';
import { XUnavailable, XNoSuchSource } from '../x/errors.js';
import { failureResult } from '../failure.js';
import { facebookSpecFromRef } from './canonical.js';
import { scrapeFacebookPage } from './scrape.js';

/**
 * Pinned rather than floating. Graph deprecates a version roughly every two
 * years with a hard cutoff, and an unpinned call silently changes shape under
 * you; a pinned one fails loudly on a date that can be looked up.
 */
const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * What a post is, in the fewest fields that render.
 *
 * `message` is the caption and is absent on a share with no comment;
 * `permalink_url` is the only stable public address; `full_picture` is the
 * attached image where there is one. `story` carries the "X shared a link"
 * sentence that stands in for a caption when there is none.
 */
const FIELDS = 'id,message,story,created_time,permalink_url,full_picture';

/**
 * Collect one Facebook Page.
 *
 * @param {{ social_ref?: string, feed_url?: string, item_count?: number }} feed
 * @param {{ runtime: { env?: Record<string, string|undefined>, onEvent?: Function }, signal?: AbortSignal }} opts
 * @returns {Promise<object>}
 */
export async function fetchFacebookSource(feed, opts) {
  const spec = facebookSpecFromRef(feed?.social_ref);
  if (!spec) return { ok: false, error: 'invalid-facebook-ref' };

  const env = opts.runtime?.env ?? process.env;
  const onEvent = opts.runtime?.onEvent ?? (() => {});

  // The Page's own spelling, for anything a human reads.
  //
  // `social_ref` is lowercased because it is an identity — `fb:page:somepage`
  // has to match however the URL was typed — but lowercasing is not ours to do
  // to somebody's name, and every item title carries it. `feed_url` kept the
  // original casing at submission, so display comes from there and identity
  // stays from the ref.
  const display = displayName(feed?.feed_url) ?? spec.page;

  try {
    // Two ways in, and the cheap one is not the default.
    //
    // A Page Access Token is strictly better where it exists — a supported API,
    // structured posts, no markup to guess at — but it only ever exists for a
    // Page somebody administers, which is almost none of them. So Graph is used
    // when a token happens to be configured for this Page, and the session
    // scrape carries everything else. Neither needs configuring per source.
    const token = pageToken(env, spec.page);

    if (!token) {
      const cookie = String(env.FB_COOKIE ?? '').trim();
      onEvent('facebook.fetch.started', { ref: feed.social_ref, via: 'mbasic' });

      const scraped = await scrapeFacebookPage(spec, {
        cookie,
        timeoutMs: Number(env.X_FETCH_TIMEOUT_MS) || undefined,
        fetch: opts.runtime?.fetch,
        signal: opts.signal,
      });

      const items = scraped.posts.map((post) => fromScrape(post, display)).filter(Boolean);

      if (items.length === 0 && Number(feed?.item_count ?? 0) > 0) {
        onEvent('facebook.fetch.failed', { ref: feed.social_ref, error: 'empty-result' });
        return { ok: false, throttled: true, retryAfter: 20 * 60, error: 'empty-result' };
      }

      onEvent('facebook.fetch.success', {
        ref: feed.social_ref,
        via: 'mbasic',
        itemCount: items.length,
      });

      return {
        ok: true,
        feedUrl: feed.feed_url,
        feed: {
          title: `${scraped.displayName ?? display} on Facebook`,
          description: `Posts from the ${display} Page on Facebook, mirrored by RSS Amplifier.`,
          siteUrl: String(feed.feed_url),
          language: null,
          imageUrl: null,
          categories: [],
          kind: 'blog',
          items,
        },
      };
    }

    const url = new URL(`${GRAPH}/${encodeURIComponent(spec.page)}/posts`);
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('limit', '50');
    url.searchParams.set('access_token', token);

    onEvent('facebook.fetch.started', { ref: feed.social_ref });

    const { body } = await providerGet(url, {
      provider: 'facebook-graph',
      headers: { accept: 'application/json' },
      timeoutMs: Number(env.X_FETCH_TIMEOUT_MS) || undefined,
      // Injected by tests, so a suite never reaches a real upstream (§51).
      fetch: opts.runtime?.fetch,
      signal: opts.signal,
    });

    const payload = JSON.parse(body);

    // Graph answers 200 with an `error` object for several real failures, so
    // the status code alone is not the answer — the same trap RSSHub sets.
    if (payload?.error) {
      const code = Number(payload.error.code);
      // 100 (unknown path) and 803 (unresolvable alias) mean the Page is gone
      // or renamed; that is the one failure genuinely about the source.
      if (code === 100 || code === 803) {
        throw new XNoSuchSource(`facebook: ${payload.error.message ?? 'no such page'}`);
      }
      throw new XUnavailable(`facebook: ${payload.error.message ?? 'graph error'}`);
    }

    const items = (payload?.data ?? []).map((post) => toItem(post, display)).filter(Boolean);

    if (items.length === 0 && Number(feed?.item_count ?? 0) > 0) {
      onEvent('facebook.fetch.failed', { ref: feed.social_ref, error: 'empty-result' });
      return { ok: false, throttled: true, retryAfter: 20 * 60, error: 'empty-result' };
    }

    onEvent('facebook.fetch.success', { ref: feed.social_ref, itemCount: items.length });

    return {
      ok: true,
      feedUrl: feed.feed_url,
      feed: {
        title: `${display} on Facebook`,
        description: `Posts from the ${display} Page on Facebook, mirrored by RSS Amplifier.`,
        siteUrl: String(feed.feed_url),
        language: null,
        imageUrl: null,
        categories: [],
        kind: 'blog',
        items,
      },
    };
  } catch (error) {
    onEvent('facebook.fetch.failed', { ref: feed.social_ref, error: String(error?.message ?? error) });
    return failureResult(error);
  }
}

/**
 * One scraped post as one of our items.
 *
 * Deliberately the same shape `toItem` produces from Graph, so that a Page
 * which gains a token later does not change identity: both key on the post id,
 * so `fb:<id>` is the same guid whichever way the post was read, and switching
 * does not mark a subscriber's whole feed unread.
 *
 * @param {{ id: string, url: string, text: string, createdAt: string|null, image: string|null }} post
 * @param {string} display
 */
function fromScrape(post, display) {
  if (!post?.id) return null;

  const first = String(post.text ?? '').split('\n').find(Boolean) ?? '';
  const title = first ? clip(first, 110) : '(photo)';

  return {
    guid: `fb:${post.id}`,
    url: post.url,
    title: `${display}: ${title}`,
    summary: clip(post.text, 400) || null,
    contentHtml: html(post.text, post.image, post.url),
    author: display,
    publishedAt: post.createdAt,
    imageUrl: post.image,
    categories: [],
    audio: null,
  };
}

/**
 * One Graph post as one of our items.
 *
 * @param {object} post
 * @param {string} display the Page's own spelling of its name
 * @returns {object|null}
 */
function toItem(post, display) {
  if (!post?.id) return null;

  // A caption, or the sentence Facebook writes when there is none. A post with
  // neither is a bare photo, and gets a title that says so rather than an empty
  // one — every format we render needs a title.
  const text = String(post.message ?? post.story ?? '').trim();
  const first = text.split('\n').find(Boolean) ?? '';
  const title = first ? clip(first, 110) : '(photo)';

  return {
    // The Graph post id, never the permalink: a Page rename rewrites every
    // permalink it has ever had, and a URL-keyed dedupe would re-ingest the
    // whole Page the day that happens.
    guid: `fb:${post.id}`,
    url: post.permalink_url ?? `https://www.facebook.com/${display}`,
    title: `${display}: ${title}`,
    summary: clip(text, 400) || null,
    contentHtml: html(text, post.full_picture, post.permalink_url),
    author: display,
    publishedAt: post.created_time ?? null,
    imageUrl: post.full_picture ?? null,
    categories: [],
    audio: null,
  };
}

/**
 * The rendered body. Escaped rather than sanitised, because none of it is
 * markup: Graph returns a plain-text caption, and the only tags in the output
 * are ones this function wrote.
 */
function html(text, picture, permalink) {
  const blocks = [];
  if (text) blocks.push(`<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`);
  if (picture) {
    const img = `<img src="${escapeHtml(picture)}" alt="" loading="lazy">`;
    blocks.push(permalink ? `<p><a href="${escapeHtml(permalink)}">${img}</a></p>` : `<p>${img}</p>`);
  }
  return blocks.join('\n') || '<p>(no text)</p>';
}

/**
 * The token for one Page, from `FB_PAGE_TOKENS`.
 *
 * Structured JSON rather than parallel lists, for the reason spelled out in
 * `../x/sessions.js`: positional pairs silently mispair when one entry is
 * removed, and a mispaired credential authenticates as nobody.
 *
 *   FB_PAGE_TOKENS=[{"page":"MyPage","token":"EAA..."}]
 *
 * Matched case-insensitively on either the vanity name or the numeric id, so a
 * Page connected as `MyPage` is found by a source stored as `mypage`.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} page
 * @returns {string|null}
 */
export function pageToken(env, page) {
  const raw = String(env.FB_PAGE_TOKENS ?? '').trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    const wanted = String(page).toLowerCase();
    const match = parsed.find(
      (entry) =>
        String(entry?.page ?? entry?.pageId ?? entry?.id ?? '').toLowerCase() === wanted,
    );

    const token = String(match?.token ?? match?.accessToken ?? '').trim();
    return token || null;
  } catch {
    // A malformed FB_PAGE_TOKENS must not stop the crawler booting, and must
    // not be reported as "this Page is broken" either — it reads as no token,
    // which is the honest answer.
    return null;
  }
}

/** Which Pages have a token at all, for the status page and the add form. */
export function connectedPages(env = process.env) {
  const raw = String(env.FB_PAGE_TOKENS ?? '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => String(entry?.page ?? entry?.pageId ?? entry?.id ?? '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The Page name as it was written, read back off the stored URL.
 *
 * @param {unknown} feedUrl
 * @returns {string|null}
 */
function displayName(feedUrl) {
  const match = /facebook\.com\/([A-Za-z0-9.]{3,60})\/?$/.exec(String(feedUrl ?? ''));
  return match ? match[1] : null;
}

/** @param {string} value @param {number} max */
function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** @param {string} value */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
