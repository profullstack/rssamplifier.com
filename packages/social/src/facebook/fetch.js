/**
 * Collecting Facebook, for the Pages somebody has actually connected.
 *
 * See `./canonical.js` for why this is the only shape available: there is no
 * way to read an arbitrary public Page, so a Facebook source is not something a
 * stranger submits — it is something a Page's operator connects by supplying a
 * Page Access Token.
 *
 * **Tokens live in the environment, keyed by Page**, never in a table, for
 * exactly the reason X's session cookies do not: a Page Access Token can post
 * as the Page. `FB_PAGE_TOKENS` is a JSON array, and a Page with no entry in it
 * is not "not crawled yet" — it is not collectable, and both the crawler and
 * the page say so rather than retrying for ever.
 *
 * This is the one collector in the package that talks to a real, supported,
 * documented API rather than a bridge, which makes it the least likely of the
 * three to break and the one with the smallest reach. That trade is Meta's, not
 * ours.
 */

import { providerGet } from '../x/providers/http.js';
import { XUnavailable, XNoSuchSource } from '../x/errors.js';
import { failureResult } from '../failure.js';
import { facebookSpecFromRef } from './canonical.js';

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
    const token = pageToken(env, spec.page);
    if (!token) {
      // Not an outage and not a broken Page: nobody has connected it. Phrased
      // so `retryAfterFor` gives it the hour it deserves rather than retrying
      // every twenty minutes for a token that is not coming.
      throw new XUnavailable(`facebook: page ${spec.page} is not connected`);
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
  const match = /facebook\.com\/([A-Za-z0-9.]{5,60})\/?$/.exec(String(feedUrl ?? ''));
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
