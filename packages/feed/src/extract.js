import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import { sanitizeHtml, textLength } from './sanitize.js';

/**
 * Read a page the reader is not allowed to frame.
 *
 * Framing is the reader's first choice because it shows the publisher's own
 * page, exactly as they built it. Most of the web refuses: X-Frame-Options and
 * frame-ancestors are near-universal on anything with an ad stack, and the
 * reader has been answering that refusal with a card, a one-line summary and a
 * link out. That is a dead end dressed up as a feature — the reader clicked to
 * read, and got told to go somewhere else to do it.
 *
 * So when the frame is refused, the article is pulled out of the page we
 * already fetched to decide that, and rendered here instead. Same trade brisk
 * makes: Readability over the fetched HTML, sanitized to the same allowlist
 * everything else on the page goes through.
 *
 * What this deliberately is not: a way around a paywall, a crawler, or a
 * cache. One page is read when one reader opens it, the result is stored
 * against that one post, and the original stays a click away in the toolbar.
 */

/**
 * Shortest extraction worth showing, when prose is all there is.
 *
 * Readability will happily return a nav sidebar and a cookie notice off a page
 * that is mostly JavaScript, and a reader who is shown 200 characters of
 * furniture has been told this worked when it did not. Below this, the honest
 * card is the better answer.
 *
 * It is a floor on *prose*, which is the whole of the trouble: it was being
 * asked about pages whose post is a picture. A Wilde Life strip extracts
 * cleanly — the full-size panel, with the artist's alt text on it — and carries
 * 502 characters of prose around it, so the reader threw the comic away and
 * said the site would not let itself be embedded. Same for Elephant Town, and
 * for photo posts, and for any page whose words are a caption. See `figures`.
 */
const MIN_LENGTH = 600;

/**
 * Below this in either declared dimension, an image is furniture.
 *
 * Only load-bearing when a page says how big its images are, which most do not
 * — but when a site does declare, a 200×100 publisher logo is saying plainly
 * that it is not the post.
 */
const MIN_FIGURE_PX = 200;

/**
 * Where a site keeps its chrome rather than its posts.
 *
 * Measured against the pages this gate was rejecting, not guessed. Elephant
 * Town's page furniture is six nav arrows under `/templates/2021/images/`; the
 * one image that is the comic sits under `/comics/`. A Mastodon-ish profile
 * card on heretic.li — a bio and a link list, which is furniture entire —
 * offers only an avatar under `/static/`, and dropping that is what keeps the
 * card from being rendered as though it were a post.
 *
 * `/images/` is deliberately absent: it is where half the small web puts its
 * photographs.
 */
const CHROME_DIRS =
  /\/(?:static|assets|templates?|themes?|skins?|icons?|logos?|emoji|sprites?)\//i;

/** Filenames that announce themselves as furniture. */
const CHROME_NAMES = /(?:^|[/_-])(?:logo|avatar|icon|badge|button|sprite|pixel|spacer)s?[._-]/i;

/**
 * Largest page worth parsing.
 *
 * Generous on purpose. A commercial article page is mostly not the article:
 * MusicRadar ships 1.1MB for 11KB of prose, nearly all of it inline JSON, ad
 * configuration and preloaded state, and the body sits past the point a
 * tighter budget would have cut. A cap that truncates before the article does
 * not save the reader anything — it just turns a page that would have worked
 * into "this cannot be shown here".
 */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

/**
 * Pull the article out of a fetched page.
 *
 * No network, so the interesting half is testable without one.
 *
 * The `<base>` is what makes the result usable rather than merely present.
 * Readability resolves relative URLs against the document's own base, and a
 * document parsed from a string has none — so every `/images/hero.jpg` stays
 * relative, and the sanitizer drops relative URLs on purpose (they would
 * otherwise point at rssamplifier.com). Without this the article renders with
 * its images and links stripped, which reads as a broken extraction rather
 * than a missing base tag.
 *
 * @param {string} html the page source
 * @param {string} url the URL it was fetched from, after redirects
 * @returns {{ title: string|null, byline: string|null, excerpt: string|null,
 *   siteName: string|null, html: string, length: number }|null} null when
 *   there is no article here worth showing
 */
export function readableArticle(html, url) {
  const source = String(html ?? '');
  if (!source.trim()) return null;

  const capped = source.length > MAX_HTML_BYTES ? source.slice(0, MAX_HTML_BYTES) : source;
  const based = withBase(capped, url);

  let article;
  try {
    const { document } = parseHTML(based);
    article = new Readability(document).parse();
  } catch {
    // Readability walks a DOM it did not build and throws on shapes linkedom
    // produces from malformed markup. A page we cannot parse is a page we
    // cannot read, which the caller already knows how to say.
    return null;
  }

  if (!article?.content) return null;

  const clean = sanitizeHtml(String(article.content));
  const length = textLength(clean);

  // Prose is enough on its own, and a picture is enough on its own. Requiring
  // prose of a page that is a picture is what turned every webcomic in the
  // directory into "this site does not allow itself to be embedded".
  if (length < MIN_LENGTH && figures(clean, url).length === 0) return null;

  return {
    title: text(article.title),
    byline: text(article.byline),
    excerpt: text(article.excerpt),
    siteName: text(article.siteName),
    html: clean,
    length,
  };
}

/**
 * The images in an extraction that could plausibly be the post.
 *
 * The question this answers is not "is there an image" — every page has images
 * — but "did we come away with something worth showing a reader". One picture
 * that the publisher serves themselves, at a size they have not disclaimed, is
 * a post the same way six hundred characters of prose is a post.
 *
 * Three tests, each of which earns its place against a page this gate was
 * getting wrong:
 *
 *   - Served from the publisher's own site. Wilde Life's extraction carries a
 *     topwebcomics.com vote badge; a third party's image on someone else's page
 *     is an ad or a button, never the thing that was published.
 *   - Not declared small. The Hiveworks logo on the same page says width="200"
 *     height="100", which is a site saying this is a logo.
 *   - Not filed under the site's chrome. See CHROME_DIRS.
 *
 * Exported for the tests, which is the only way to pin behaviour that is
 * otherwise visible as one boolean at the end of a long function.
 *
 * @param {string} html the sanitized extraction
 * @param {string} url the page it came from
 * @returns {string[]} the sources of the images that survived
 */
export function figures(html, url) {
  const site = siteOf(url);
  const found = [];

  for (const tag of String(html ?? '').matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(tag[0], 'src');
    if (!src) continue;

    // The sanitizer has already dropped relative and non-http sources, so
    // anything still here parses — but a parse that fails is not a figure.
    if (siteOf(src) !== site) continue;

    const width = Number(attr(tag[0], 'width'));
    const height = Number(attr(tag[0], 'height'));
    if (width > 0 && width < MIN_FIGURE_PX) continue;
    if (height > 0 && height < MIN_FIGURE_PX) continue;

    let path = '';
    try {
      path = new URL(src).pathname;
    } catch {
      continue;
    }
    if (CHROME_DIRS.test(path)) continue;
    if (CHROME_NAMES.test(path)) continue;

    found.push(src);
  }

  return found;
}

/**
 * The site an URL belongs to, so a CDN subdomain still counts as the
 * publisher's own: images.example.com and www.example.com are one site, and a
 * page that serves its photographs off the first is not serving someone else's.
 *
 * Two labels rather than a public-suffix list. It is wrong for example.co.uk,
 * where it answers "co.uk" for both sides of a comparison that should have
 * failed — which costs a third-party image on a .co.uk page being counted, and
 * never costs a real one being dropped.
 *
 * @param {string} url
 * @returns {string|null}
 */
function siteOf(url) {
  try {
    const { hostname } = new URL(String(url));
    return hostname.split('.').slice(-2).join('.').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {string} tag
 * @param {string} name
 * @returns {string}
 */
function attr(tag, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag);
  return match ? match[1] : '';
}

/**
 * Give a parsed-from-string document the base URL it would have had if a
 * browser had loaded it.
 *
 * A page's own `<base>` wins if it has one — that is what the browser would
 * honour, and a site that sets one means it.
 *
 * @param {string} html
 * @param {string} url
 * @returns {string}
 */
function withBase(html, url) {
  if (/<base\b[^>]*\bhref=/i.test(html)) return html;

  const href = escapeAttr(url);
  const tag = `<base href="${href}">`;

  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  return `<head>${tag}</head>${html}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Readability returns '' for absent fields and leaves entities in titles.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function text(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  return decodeEntities(trimmed);
}

/**
 * The named entities a headline actually contains.
 *
 * Readability hands back the title straight off the page, entities and all —
 * `&ldquo;Mutt said&rdquo;` renders as literal text once it goes through JSX,
 * which escapes it again. Only the handful that show up in prose are decoded;
 * this is not an HTML parser and does not need to be.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    hellip: '…', mdash: '—', ndash: '–', times: '×',
  };

  return value
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&#x([\da-f]+);/gi, (_, h) => safeChar(Number.parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => named[String(name).toLowerCase()] ?? whole);
}

/**
 * @param {number} code
 * @returns {string}
 */
function safeChar(code) {
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
