import { safeFetch, safeFetchBytes } from './fetch.js';
import { imageSize } from './imagesize.js';

/**
 * The one picture that stands for a whole feed.
 *
 * Two jobs, one answer. A listing needs something to put beside a feed's name,
 * and three quarters of the blogs in this directory declare no cover art in
 * their feed document at all. A shared link needs an `og:image`, and the feed
 * pages had none — not for want of a URL, but because a URL alone is not enough
 * to know whether handing it to a social-media crawler would produce a card or a
 * 32×32 favicon stretched across somebody's timeline.
 *
 * So the answer is fetched rather than assumed: whatever the publisher offers is
 * asked for, a couple of kilobytes of it are read, and the file's own header says
 * how big it is. That measurement is what makes both uses safe, and it is why
 * this is a crawl-time step rather than something a page could do while somebody
 * waits for it.
 *
 * Where the candidates come from, in order:
 *
 * 1. The feed's own cover art — `<image>`, `itunes:image`, an Atom `logo`. The
 *    publisher put it in a machine-readable document, which makes it the most
 *    deliberate answer available.
 * 2. `og:image` on the site's home page. This is the picture the publisher
 *    already chose for exactly this purpose, and it is the reason most of the
 *    directory can have a card at all.
 * 3. `twitter:image`, for the sites that set only that one.
 *
 * One page fetch and at most two image probes per feed, which is why the poller
 * runs it over a small batch on a long timer rather than during a crawl.
 */

/** Smallest picture Open Graph will render as a card at all. */
export const CARD_MIN = 200;

/** From here up, a card is rendered wide rather than as a thumbnail beside text. */
export const CARD_LARGE_WIDTH = 600;

/** …and this tall, which is the 1.91:1 ratio the large card is cropped to. */
export const CARD_LARGE_HEIGHT = 315;

/** Bytes read per image. Enough for any header short of a fat EXIF block. */
const PROBE_BYTES = 32 * 1024;

/**
 * Read the picture a page nominates for itself.
 *
 * Regex rather than a DOM parse, unlike the rest of the scraper: this runs over
 * the home page of every feed in the directory, the whole question is one
 * attribute of one tag, and a page whose `<head>` is malformed enough to defeat
 * this has a bigger problem than its card.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{ og: string, twitter: string }}
 */
export function cardCandidatesFromPage(html, pageUrl) {
  const find = (property) => {
    // Either attribute order, single or double quotes, `property` or `name` —
    // all four spellings are common, and og:image with name= is the one a
    // stricter reader would miss most often.
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*?content\\s*=\\s*["']([^"']+)["']`,
        'i',
      ),
      new RegExp(
        `<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*?(?:property|name)\\s*=\\s*["']${property}["']`,
        'i',
      ),
    ];

    for (const pattern of patterns) {
      const found = pattern.exec(html);
      if (found?.[1]) return absolute(found[1], pageUrl);
    }
    return '';
  };

  return {
    og: find('og:image:secure_url') || find('og:image:url') || find('og:image'),
    twitter: find('twitter:image:src') || find('twitter:image'),
  };
}

/**
 * @param {string} href
 * @param {string} base
 * @returns {string}
 */
function absolute(href, base) {
  const raw = String(href ?? '')
    .replace(/&amp;/gi, '&')
    .trim();
  if (!raw) return '';

  try {
    const url = new URL(raw, base || undefined);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Is this measurement good enough to be a card?
 *
 * A known format whose size could not be read — an AVIF, an SVG, a JPEG with a
 * very large EXIF block — is deliberately *not* a card. It may well be a fine
 * picture, and it is still stored and still shown in listings; what it cannot do
 * is be promised to a crawler that will reject or badly crop it.
 *
 * @param {{ type: string, width: number, height: number }|null} size
 * @returns {'large'|'small'|'none'}
 */
export function cardFit(size) {
  if (!size || !size.width || !size.height) return 'none';
  if (size.type === 'svg') return 'none'; // no crawler renders one
  if (size.width < CARD_MIN || size.height < CARD_MIN) return 'none';
  return size.width >= CARD_LARGE_WIDTH && size.height >= CARD_LARGE_HEIGHT ? 'large' : 'small';
}

/**
 * Measure one candidate URL.
 *
 * @param {string} url
 * @param {{ fetchBytes?: typeof safeFetchBytes }} [deps]
 * @returns {Promise<{ url: string, type: string, width: number, height: number, fit: string }|null>}
 */
export async function probeImage(url, { fetchBytes = safeFetchBytes } = {}) {
  if (!url) return null;

  const res = await fetchBytes(url, PROBE_BYTES);
  if (!res.ok || res.bytes.length === 0) return null;

  // The content type is not trusted to decide what this is — plenty of hosts
  // serve images as application/octet-stream, and one that claims image/png for
  // an HTML error page should not be believed either. The header bytes decide.
  const size = imageSize(res.bytes);
  if (!size) return null;

  return {
    // The URL after redirects: a publisher's /logo.png that 301s to a CDN should
    // be stored as the CDN URL, so neither a reader's browser nor a crawler pays
    // for the hop.
    url: res.url,
    type: size.type,
    width: size.width,
    height: size.height,
    fit: cardFit(size),
  };
}

/**
 * Find and measure the best picture for one feed.
 *
 * Returns the first candidate that is genuinely an image, preferring one that
 * can also serve as a card: cover art that turns out to be a favicon does not
 * stop the site's `og:image` from being tried, because the two are wanted for
 * different things and the second is usually the bigger.
 *
 * @param {{ imageUrl?: string|null, siteUrl?: string|null }} feed
 * @param {{ fetchPage?: typeof safeFetch, fetchBytes?: typeof safeFetchBytes }} [deps]
 * @returns {Promise<{
 *   state: 'ok'|'none'|'error',
 *   url: string, width: number, height: number, type: string, fit: string,
 *   source: string,
 * }>}
 */
export async function findFeedCard(feed, deps = {}) {
  const { fetchPage = safeFetch, fetchBytes = safeFetchBytes } = deps;

  /** @type {Array<{ source: string, url: string }>} */
  const candidates = [];
  if (feed?.imageUrl) candidates.push({ source: 'cover', url: String(feed.imageUrl) });

  // The page is only fetched when there is somewhere to fetch it from, and its
  // failure is not the feed's failure — a site that is down still has whatever
  // cover art its feed declared.
  let pageFailed = false;
  if (feed?.siteUrl) {
    const page = await fetchPage(String(feed.siteUrl));
    if (page.ok && page.body) {
      const found = cardCandidatesFromPage(page.body, page.url);
      if (found.og) candidates.push({ source: 'og', url: found.og });
      if (found.twitter) candidates.push({ source: 'twitter', url: found.twitter });
    } else {
      pageFailed = true;
    }
  }

  const seen = new Set();
  /** @type {{ state: 'ok', url: string, width: number, height: number, type: string, fit: string, source: string }|null} */
  let best = null;

  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);

    const probed = await probeImage(candidate.url, { fetchBytes });
    if (!probed) continue;

    const answer = { state: /** @type {'ok'} */ ('ok'), ...probed, source: candidate.source };

    // A card beats a picture, and a large card beats a small one. Anything that
    // is an image at all is still kept as the fallback, because a listing avatar
    // has no minimum size.
    if (probed.fit === 'large') return answer;
    if (!best || rank(probed.fit) > rank(best.fit)) best = answer;
  }

  if (best) return best;

  return {
    // 'none' is a finding, not a failure: it means we looked and this publisher
    // offers no picture, and the backfill should not keep asking. 'error' is the
    // opposite, and is what a retry is for.
    state: pageFailed && candidates.length === 0 ? 'error' : 'none',
    url: '',
    width: 0,
    height: 0,
    type: '',
    fit: 'none',
    source: '',
  };
}

/**
 * @param {string} fit
 * @returns {number}
 */
function rank(fit) {
  return fit === 'large' ? 2 : fit === 'small' ? 1 : 0;
}
