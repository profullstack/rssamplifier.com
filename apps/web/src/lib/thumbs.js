/**
 * Which picture, if any, goes beside a row.
 *
 * The directory stores what the publisher declared and nothing more: no copy of
 * the file, no resized version, no cached bytes. A thumbnail here is a URL on
 * somebody else's host, rendered at a size we choose — which is the same
 * arrangement as the audio, the video and the framed reader, and the reason the
 * CSP says `img-src https:` rather than naming any host.
 *
 * That makes this module the whole trust boundary for images: every `src` the
 * site renders passes through `thumbSrc`, and anything it cannot vouch for
 * becomes no image at all rather than a broken one.
 */

/**
 * Smallest picture Open Graph will render as a card at all, and the size from
 * which a card is rendered wide rather than as a thumbnail beside text.
 *
 * Duplicated from `@rssamplifier/feed`'s card module rather than imported: these
 * are read by `generateMetadata` on a page that has no other reason to pull the
 * feed package into the web bundle, and they are two numbers fixed by somebody
 * else's spec. The crawl-time side owns the same constants and the card test
 * asserts the gate there.
 */
const CARD_MIN = 200;
const CARD_LARGE_WIDTH = 600;
const CARD_LARGE_HEIGHT = 315;

/**
 * Longest URL worth putting in an attribute.
 *
 * Real image URLs with a signed CDN query run to a few hundred characters. Well
 * past that and it is either a data: blob that slipped through ingest or a
 * generated tracking URL, and neither belongs in fifty rows of markup.
 */
const MAX_LENGTH = 1000;

/**
 * A validated image URL, or null.
 *
 * Three things it rules out, each of which is in the database somewhere:
 *
 * - A non-http(s) scheme. `data:` would be a base64 blob inlined into every
 *   listing that shows it; `javascript:` is inert in `src` but there is no
 *   reason to emit it.
 * - A relative or malformed URL. Ingest now absolute-ises what it stores, but
 *   rows written before that resolve against *our* origin — a 404 on
 *   rssamplifier.com for an image that exists on the publisher's site.
 * - `http:`, which the browser blocks as mixed content on an https page and
 *   which our own CSP does not allow either. Upgraded rather than dropped: an
 *   image host without TLS in 2026 is rare, a publisher who has TLS and an old
 *   absolute URL in their feed template is not, and the failure mode of
 *   guessing wrong is one blank square.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function thumbSrc(raw) {
  const candidate = String(raw ?? '').trim();
  if (!candidate || candidate.length > MAX_LENGTH) return null;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return null;

  return url.href;
}

/**
 * The thumbnail for a post row, falling back to its feed's cover art.
 *
 * The fallback is what makes a listing a column of pictures rather than a
 * column with gaps in it, and it is honest: a podcast episode with no art of
 * its own is meant to be shown under the show's cover, and a blog's icon beside
 * its post says whose post it is. The row has to carry `feed_image` for this to
 * fire — the river, search, queue and favorites queries select it; a feed's own
 * page passes the feed in instead, because every row there has the same one.
 *
 * @param {Record<string, unknown>} [row]
 * @param {Record<string, unknown>} [feed] The feed all rows belong to, where
 *   the caller knows it.
 * @returns {string|null}
 */
export function postThumb(row, feed) {
  return (
    thumbSrc(row?.image_url) ??
    thumbSrc(row?.feed_image) ??
    thumbSrc(row?.feed_card) ??
    thumbSrc(feed?.image_url) ??
    thumbSrc(feed?.card_url) ??
    null
  );
}

/**
 * The picture beside a feed's name.
 *
 * Two columns, in order of provenance. `image_url` is what the publisher put in
 * their feed document. `card_url` is what the crawler found by going and looking
 * at their site — usually its `og:image` — and it exists because three quarters
 * of the blogs here declare no cover art at all, which left three quarters of
 * every listing as initials.
 *
 * @param {Record<string, unknown>} [feed]
 * @returns {string|null}
 */
export function feedImage(feed) {
  return thumbSrc(feed?.image_url) ?? thumbSrc(feed?.card_url) ?? null;
}

/**
 * The social card for a feed's page, or null where there is honestly none.
 *
 * The dimensions are the whole point of the gate. A crawler handed a 32x32
 * favicon renders a broken-looking card or none at all, and the generated card
 * this falls back to is better than either — so a picture is only promised when
 * the crawler measured it at crawl time and it cleared the size Open Graph
 * asks for. `large` decides the Twitter card type rather than whether to have
 * one.
 *
 * @param {Record<string, unknown>} [feed]
 * @returns {{ url: string, width: number, height: number, large: boolean }|null}
 */
export function feedCard(feed) {
  const url = thumbSrc(feed?.card_url);
  const width = Number(feed?.card_width ?? 0);
  const height = Number(feed?.card_height ?? 0);

  if (!url || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < CARD_MIN || height < CARD_MIN) return null;

  return {
    url,
    width,
    height,
    large: width >= CARD_LARGE_WIDTH && height >= CARD_LARGE_HEIGHT,
  };
}

/**
 * The letter that stands in for a feed with no cover art.
 *
 * Three quarters of the blogs in the directory publish no icon of any kind, and
 * a listing where a quarter of the rows have a picture and the rest have a hole
 * looks broken in a way that a listing of initials does not. Digits and letters
 * both pass through; anything else — an emoji title, a CJK title, punctuation —
 * is taken as-is at its first character, which is a better monogram than a
 * question mark.
 *
 * @param {unknown} title
 * @returns {string}
 */
export function monogram(title) {
  const text = String(title ?? '').trim();
  if (!text) return '·';

  // By code point, not by index: a title starting with an astral character
  // would otherwise render half a surrogate pair.
  const [first] = Array.from(text);
  return first.toUpperCase();
}

/**
 * A stable tint for a monogram, from the feed's slug.
 *
 * Not random, and not stored: the same feed gets the same colour on every page
 * it appears on, and two feeds next to each other almost never share one. The
 * hue is all that varies — saturation and lightness are fixed in the stylesheet
 * so the tile stays quiet next to type either side of it, in both themes.
 *
 * @param {unknown} key
 * @returns {number} Degrees on the colour wheel.
 */
export function monogramHue(key) {
  const text = String(key ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    // Cheap, deterministic, and the same in every runtime. This is decoration,
    // not a hash anything depends on.
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }
  return hash;
}
