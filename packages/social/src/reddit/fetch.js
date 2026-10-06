/**
 * Collecting a subreddit or a Reddit user, through Arctic Shift.
 *
 * Reddit used to be the one network that was fetched rather than collected,
 * because it publishes RSS. It still does; it just does not reliably publish it
 * to us. See `arctic.js` for the numbers. The row keeps its reddit.com
 * `feed_url` on purpose: the crawler spreads and caps work per host of that
 * URL, so fifty thousand subreddits still queue behind one host's budget and
 * the mirror is asked at the pace Reddit was, not fifty thousand times at once.
 *
 * No runtime is needed — no session, no bridge, no key — which is why this is
 * the one collector the crawler runs when X is switched off.
 */

import { failureResult } from '../failure.js';
import { fetchRedditListing, postToItem } from './arctic.js';
import { redditSiteUrl, redditSpecFromRef, redditTitle } from './canonical.js';

/**
 * @param {{ social_ref?: string, feed_url?: string, item_count?: number }} feed
 * @param {{ runtime?: { env?: Record<string, string|undefined>, onEvent?: Function, fetch?: typeof fetch } | null, signal?: AbortSignal }} [opts]
 * @returns {Promise<object>}
 */
export async function fetchRedditSource(feed, opts = {}) {
  const spec = redditSpecFromRef(feed?.social_ref);
  if (!spec) return { ok: false, error: 'invalid-reddit-ref' };

  const runtime = opts.runtime ?? {};
  const onEvent = runtime.onEvent ?? (() => {});

  try {
    onEvent('reddit.fetch.started', { ref: feed.social_ref });
    const posts = await fetchRedditListing(spec, {
      env: runtime.env,
      fetch: runtime.fetch,
      signal: opts.signal,
    });
    const items = posts.map(postToItem).filter(Boolean);

    // Same reasoning as Instagram's: a source that had posts and now returns
    // none is the mirror having a bad minute, not a community going silent.
    if (items.length === 0 && Number(feed?.item_count ?? 0) > 0) {
      onEvent('reddit.fetch.failed', { ref: feed.social_ref, error: 'empty-result' });
      return { ok: false, throttled: true, retryAfter: 20 * 60, error: 'empty-result' };
    }

    onEvent('reddit.fetch.success', { ref: feed.social_ref, itemCount: items.length });

    // Reddit's casing for the name, when the archive has it, so a row created
    // from a lowercased ref still titles itself `r/AskTechnology`.
    const named = posts[0]?.[spec.mode === 'user' ? 'author' : 'subreddit'];
    const display = { ...spec, name: named && String(named).toLowerCase() === spec.name.toLowerCase() ? String(named) : spec.name };

    return {
      ok: true,
      feedUrl: feed.feed_url,
      feed: {
        title: redditTitle(display),
        description:
          spec.mode === 'user'
            ? `Posts by u/${display.name} on Reddit, mirrored by RSS Amplifier.`
            : `Posts from r/${display.name}, mirrored by RSS Amplifier.`,
        siteUrl: redditSiteUrl(display),
        language: null,
        imageUrl: null,
        categories: [],
        kind: 'blog',
        items,
      },
    };
  } catch (error) {
    onEvent('reddit.fetch.failed', { ref: feed.social_ref, error: String(error?.message ?? error) });
    return failureResult(error);
  }
}
