/**
 * Collecting Instagram, which needs far less machinery than X did.
 *
 * X needed a normaliser because its posts have structure that survives into the
 * rendering — a repost has no text of its own, a quote is two posts in one item,
 * a reply is a fragment. Instagram has none of that: a post is a caption and
 * some pictures, and RSSHub's own rendering of it is already the item we want.
 *
 * So this parses the bridge's RSS with the ordinary feed parser and changes
 * exactly one thing: the identity. `parseFeed` keys an item on the bridge's
 * `<guid>`, and a bridge's guid is the bridge's — swap RSSHub for anything else
 * and every post in every Instagram feed changes identity, and every
 * subscriber's reader marks the whole account unread. Re-keying on the post's
 * own shortcode is what makes the collection method replaceable, which is the
 * same promise `/x/` makes (AC-2).
 */

import { parseFeed } from '@rssamplifier/feed';

import { providerGet } from '../x/providers/http.js';
import { XUnavailable } from '../x/errors.js';
import { failureResult } from '../failure.js';
import { instagramSpecFromRef } from './canonical.js';

/** Instagram post shortcodes appear in `/p/<code>/` and `/reel/<code>/`. */
const SHORTCODE = /\/(?:p|reel|tv)\/([A-Za-z0-9_-]{5,30})/;

/**
 * Collect one Instagram source, in the shape `crawlFeed` expects.
 *
 * @param {{ social_ref?: string, feed_url?: string, item_count?: number }} feed
 * @param {{ runtime: { env?: Record<string, string|undefined>, onEvent?: Function }, signal?: AbortSignal }} opts
 * @returns {Promise<object>}
 */
export async function fetchInstagramSource(feed, opts) {
  const spec = instagramSpecFromRef(feed?.social_ref);
  if (!spec) return { ok: false, error: 'invalid-instagram-ref' };

  const env = opts.runtime?.env ?? process.env;
  const onEvent = opts.runtime?.onEvent ?? (() => {});
  const base = String(env.RSSHUB_BASE_URL ?? '').replace(/\/+$/, '');

  try {
    if (!base) throw new XUnavailable('instagram: no RSSHUB_BASE_URL');

    // The web-api route (`/instagram/2/...`) rather than the private-api one.
    // Both exist upstream; this one authenticates with a cookie (`IG_COOKIE`)
    // where the other wants a username and password, and storing somebody's
    // Instagram password to read public posts is a trade nobody should make.
    const url = new URL(
      `${base}/instagram/2/${spec.mode === 'user' ? 'user' : 'hashtag'}/` +
        encodeURIComponent(spec.mode === 'user' ? spec.username : spec.tag),
    );
    if (env.RSSHUB_ACCESS_KEY) url.searchParams.set('key', String(env.RSSHUB_ACCESS_KEY));

    onEvent('instagram.fetch.started', { ref: feed.social_ref });

    const { body } = await providerGet(url, {
      provider: 'rsshub',
      timeoutMs: Number(env.X_FETCH_TIMEOUT_MS) || undefined,
      // Injected by tests, so a suite never reaches a real upstream (§51).
      fetch: opts.runtime?.fetch,
      signal: opts.signal,
    });

    const parsed = parseFeed(body, String(url));
    if (!parsed) throw new XUnavailable('instagram: unparseable-response');

    const items = (parsed.items ?? []).map(reKey).filter(Boolean);

    // An account that had posts yesterday and none today is almost always an
    // upstream that answered 200 with a page it could not fill — the same
    // reasoning, and the same treatment, as the X path (§16).
    if (items.length === 0 && Number(feed?.item_count ?? 0) > 0) {
      onEvent('instagram.fetch.failed', { ref: feed.social_ref, error: 'empty-result' });
      return { ok: false, throttled: true, retryAfter: 20 * 60, error: 'empty-result' };
    }

    onEvent('instagram.fetch.success', { ref: feed.social_ref, itemCount: items.length });

    return {
      ok: true,
      feedUrl: feed.feed_url,
      feed: {
        title: parsed.title || titleFor(spec),
        description: parsed.description || descriptionFor(spec),
        siteUrl: String(feed.feed_url),
        language: null,
        imageUrl: parsed.imageUrl ?? null,
        categories: [],
        kind: 'blog',
        items,
      },
    };
  } catch (error) {
    onEvent('instagram.fetch.failed', { ref: feed.social_ref, error: String(error?.message ?? error) });
    return failureResult(error);
  }
}

/**
 * The item, keyed on the post rather than on the bridge.
 *
 * @param {object} item a `parseFeed` item
 * @returns {object|null}
 */
function reKey(item) {
  const code = SHORTCODE.exec(String(item?.url ?? ''))?.[1] ?? SHORTCODE.exec(String(item?.guid ?? ''))?.[1];

  // No shortcode, no item. An item that cannot be deduplicated arrives again on
  // every crawl for ever, and is invisible until the feed is all duplicates.
  if (!code) return null;

  return { ...item, guid: `ig:${code}`, audio: null };
}

function titleFor(spec) {
  return spec.mode === 'user' ? `@${spec.username} on Instagram` : `#${spec.tag} on Instagram`;
}

function descriptionFor(spec) {
  return spec.mode === 'user'
    ? `Posts from @${spec.username} on Instagram, mirrored by RSS Amplifier.`
    : `Instagram posts tagged #${spec.tag}, mirrored by RSS Amplifier.`;
}
