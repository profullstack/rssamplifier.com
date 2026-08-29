/*
 * Sponsored items for the syndicated feeds.
 *
 * The site already carries CrawlProof's web units (see ./ads.js), but a feed is
 * not a page: nothing here runs `ad.js`, there is no DOM to fill, and the
 * reader is a piece of software that will keep the document for weeks. So the
 * ad has to be *in* the document, fetched while we build it.
 *
 * Two decisions are worth stating, because both are easy to get wrong later.
 *
 * **We take `as=fields`, not `as=rss`.** CrawlProof will happily hand back a
 * ready-made `<item>`, and splicing that string into our XML would be less
 * code. It would also mean two different pieces of software decide how a title
 * gets escaped inside one document, and the day their idea of escaping differs
 * from ours is the day every subscriber's reader reports a parse error on the
 * whole feed. Taking the raw fields and rendering them through `buildRss` /
 * `buildAtom` / `buildJsonFeed` keeps that decision in exactly one place — the
 * same place it is made for the other fifty items.
 *
 * **Failure is silent and total.** Every path out of here returns `[]`. A feed
 * is the product; an ad is revenue on top of it. A slow ad server, an expired
 * slot, a network blip — none of those may cost a reader their subscription, so
 * there is no retry, no error surfaced upward, and a hard timeout well under
 * the time a reader would wait.
 */

import { AD_SLOT } from './ads.js';

/** Where the ad network lives. */
const CRAWLPROOF = 'https://crawlproof.com';

/**
 * How long to wait for an ad before giving up on it.
 *
 * Deliberately short. The feed query has already run by the time we get here,
 * so this is time added directly to a response the reader is waiting on, and an
 * unsold slot costs nothing while a slow one costs everybody.
 */
const TIMEOUT_MS = 2000;

/**
 * How long a fetched ad is reused.
 *
 * The feeds are served with `max-age=300`, and CrawlProof's default identity
 * rotation is daily — so refetching per request would burn an impression for
 * every cache miss while returning an item carrying the same guid, which no
 * reader would show twice anyway. Matching the feed's own cache window keeps
 * the impression count honest about how often the ad was actually published.
 */
const CACHE_MS = 300_000;

/** @type {Map<string, { at: number, items: object[] }>} */
const cache = new Map();

/**
 * Is feed advertising on?
 *
 * Read through a non-literal property access: Next inlines `process.env.FOO` at
 * build time, which would bake the build-time value into the image and ignore
 * whatever Railway injects at runtime. Same reason `siteUrl()` does it.
 *
 * Defaults to on. Set `FEED_ADS=0` to turn every sponsored item off without a
 * deploy — the kill switch matters more than the toggle, because the thing it
 * switches off is written into documents other people keep.
 *
 * @returns {boolean}
 */
export function feedAdsEnabled() {
  const env = process.env;
  return String(env['FEED_ADS'] ?? '1') !== '0';
}

/**
 * Fetch sponsored items, already in the shape `buildSyndication` renders.
 *
 * @param {number} count how many to ask for (CrawlProof caps at 5)
 * @param {{ src?: string }} [opts] surface tag, so one slot can tell its
 *   surfaces apart in the advertiser's analytics
 * @returns {Promise<object[]>} items, or `[]` for every failure there is
 */
export async function fetchFeedAds(count, { src = 'feed' } = {}) {
  const want = Math.min(5, Math.max(0, Math.floor(count)));
  if (want === 0 || !feedAdsEnabled() || !AD_SLOT) return [];

  const key = `${want}:${src}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;

  // style=card, not the default single line. These items sit between real blog
  // posts that each have a headline, a picture and a few paragraphs, and a bare
  // sponsored line next to them does not read as restrained — it reads as
  // broken, and gets scrolled past. The card carries the advertiser's own
  // artwork, headline, body and call to action.
  const url =
    `${CRAWLPROOF}/api/ads/feed?slot=${encodeURIComponent(AD_SLOT)}` +
    `&as=fields&style=card&n=${want}&src=${encodeURIComponent(src)}`;

  let items = [];

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
      // Our own cache above is the one that decides; Next's would key on the
      // URL and outlive the process in ways that make impressions unaccountable.
      cache: 'no-store',
    });
    if (!res.ok) return remember(key, []);

    const body = await res.json();
    items = Array.isArray(body?.items) ? body.items.map(toItem).filter(Boolean) : [];
  } catch {
    // Timeout, DNS, TLS, malformed JSON — all the same answer.
    return remember(key, []);
  }

  return remember(key, items);
}

/**
 * @param {string} key
 * @param {object[]} items
 * @returns {object[]}
 */
function remember(key, items) {
  // An empty result is cached too, and on purpose: an unsold slot is the normal
  // state of a new placement, and re-asking on every feed request would add the
  // timeout to every response for nothing.
  cache.set(key, { at: Date.now(), items });
  return items;
}

/**
 * One `as=fields` payload as a syndication item.
 *
 * The mapping is where the two vocabularies meet, so it is explicit rather than
 * a spread: `guid` is our `id`, the *click* URL is our `url` (that redirector is
 * what meters the click and pays the publisher — linking the advertiser
 * directly would serve the ad for free), and `html` is the body every renderer
 * puts in `content_html`.
 *
 * `title` is taken as CrawlProof rendered it, disclosure prefix included. We do
 * not re-derive it from `headline`: the prefix is the disclosure a reader sees
 * in a title-only list, and re-assembling it here would be a second place for
 * it to go missing.
 *
 * @param {any} ad
 * @returns {object|null} null when the payload is not usable
 */
function toItem(ad) {
  const id = String(ad?.guid ?? '');
  const url = String(ad?.url ?? '');
  const title = String(ad?.title ?? '');
  // Without an identity a reader has nothing to deduplicate on and would show
  // the ad again on every poll; without a link there is nothing to click. An ad
  // missing either is not a degraded ad, it is a broken item.
  if (!id || !url || !title) return null;

  return {
    id,
    url,
    title,
    summary: typeof ad.body === 'string' && ad.body ? ad.body : null,
    content_html: typeof ad.html === 'string' && ad.html ? ad.html : null,
    // A starting date only. interleaveAds overwrites it with one derived from
    // the post the ad ends up following, because readers order by date and this
    // one would otherwise float the ad to the top of the river.
    published_at: isoOrNull(ad.publishedAt),
    author: null,
    // The advertiser's artwork, carried the same way a crawled post's picture
    // is. It is already inside content_html, but a great many readers render
    // only the thumbnail in a list view, and an item with no picture beside
    // items that all have one is the one that looks like filler.
    image_url: typeof ad.imageUrl === 'string' && ad.imageUrl ? ad.imageUrl : null,
    sponsored: true,
  };
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function isoOrNull(value) {
  const at = new Date(String(value ?? ''));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
