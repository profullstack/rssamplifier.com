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
 * Shortest extraction worth showing.
 *
 * Readability will happily return a nav sidebar and a cookie notice off a page
 * that is mostly JavaScript, and a reader who is shown 200 characters of
 * furniture has been told this worked when it did not. Below this, the honest
 * card is the better answer.
 */
const MIN_LENGTH = 600;

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
  if (length < MIN_LENGTH) return null;

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
