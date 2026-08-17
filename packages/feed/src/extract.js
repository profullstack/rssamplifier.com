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
 * More of the publisher's own pictures than a page whose post is a picture has.
 *
 * Only the rescue in `orphan` consults this, and it is there because counting
 * only the images that survive the filters is a count that can be gamed by a
 * layout. The Bright Side's comic archive is the page that proved it: ten
 * strip thumbnails, every one declared 150×150 and so ruled out for being
 * small, leaving a single survivor — a sidebar advert for the author's book —
 * which then looked exactly like a page whose one picture is the post. An
 * index of a hundred pictures is not a picture post, and how many were ruled
 * out is beside the point.
 *
 * Four rather than one, because a real strip page carries a couple of the
 * publisher's own odds and ends beside the strip and refusing those would give
 * back most of what this rescue is for. Fails closed either way: over the line
 * is the honest card, which is what these pages showed before.
 */
const CROWD = 4;

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

/**
 * Filenames that announce themselves as furniture.
 *
 * `sidebar` and `banner` join the list on the evidence of The Bright Side,
 * whose one image that is not a declared-small thumbnail is called
 * `cover-vol-2-sidebar-150-2-1.png` — an advert for the author's book, sitting
 * in the sidebar, saying so in its own name.
 */
const CHROME_NAMES =
  /(?:^|[/_-])(?:logo|avatar|icon|badge|button|sprite|pixel|spacer|sidebar|banner)s?[._-]/i;

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

  let clean = sanitizeHtml(String(article.content));
  const length = textLength(clean);

  // Prose is enough on its own, and a picture is enough on its own. Requiring
  // prose of a page that is a picture is what turned every webcomic in the
  // directory into "this site does not allow itself to be embedded".
  if (length < MIN_LENGTH && figures(clean, url).length === 0) {
    // The words without the picture, which is its own kind of failure. See
    // `orphan`.
    const missing = orphan(based, url);
    if (!missing) return null;
    clean = `${missing}${clean}`;
  }

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
 * The page's picture, when the extraction came away with only the caption.
 *
 * Readability scores subtrees and returns the one that wins, which is the right
 * shape for an article and the wrong one for a page whose post is a picture
 * with something written beside it. Sister Claire's hiatus page is the case
 * this was measured against: the strip sits in one div and the note explaining
 * the hiatus in another, Readability keeps the note — 578 characters, just
 * under the prose floor — and the comic, the whole reason the page exists, is
 * in the half that lost. The reader then fell back to the feed's own body,
 * whose picture is a 133×200 thumbnail. The post was a strip and the reader
 * showed a postage stamp.
 *
 * So the picture is looked for on the page rather than in the extraction, and
 * put back at the top where the publisher had it.
 *
 * Deliberately narrow, in three ways:
 *
 *   - Only when the extraction has already failed both tests — under the prose
 *     floor and carrying no figure of its own. An article that stands up on its
 *     own never reaches here, so no ordinary post gains an image it did not
 *     have. The alternative on this path is not "the post without a picture",
 *     it is the honest card and no post at all.
 *   - Only the same three tests `figures` applies: the publisher's own image, at
 *     a size they have not disclaimed, outside the directories a site keeps its
 *     chrome in.
 *   - Only when exactly one image survives them, on a page that was not crowded
 *     with the publisher's pictures to begin with. A page whose post is a
 *     picture has a picture; a gallery, an index or a layout has many, and
 *     guessing which one is the post is how a reader gets shown an ad. See
 *     CROWD for why both counts are needed and not just the survivors.
 *
 * Read off the DOM rather than the sanitized source because relative sources
 * are still relative here — the sanitizer drops those on purpose, and dropping
 * them is what would make this find nothing on half the small web. The tag it
 * returns is built from scratch out of three escaped attributes rather than
 * passed through, and then sanitized like everything else, so a picture rescued
 * off a page has been through exactly the allowlist the rest of the body has.
 *
 * The page is parsed again rather than shared with the caller's parse, because
 * Readability strips the document it is given as it scores it and the picture
 * is by definition in a part it threw away. A second parse is affordable
 * precisely because this only runs where the first attempt already failed.
 *
 * @param {string} html the page source, with its base href in place
 * @param {string} url the URL it was fetched from
 * @returns {string|null} an `<img>` tag, or null when the page offers no answer
 */
function orphan(html, url) {
  const site = siteOf(url);
  const found = [];
  let mine = 0;

  let document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return null;
  }

  for (const img of document.querySelectorAll('img')) {
    let src;
    try {
      src = new URL(String(img.getAttribute('src') ?? ''), url).href;
    } catch {
      continue;
    }

    if (!/^https?:/i.test(src)) continue;
    if (siteOf(src) !== site) continue;

    // Counted before the filters rather than after, because how crowded the
    // page is with the publisher's own pictures is the question the filters
    // cannot answer. See CROWD.
    mine += 1;
    if (mine > CROWD) return null;

    const width = Number(img.getAttribute('width'));
    const height = Number(img.getAttribute('height'));
    if (width > 0 && width < MIN_FIGURE_PX) continue;
    if (height > 0 && height < MIN_FIGURE_PX) continue;

    const { pathname } = new URL(src);
    if (CHROME_DIRS.test(pathname)) continue;
    if (CHROME_NAMES.test(pathname)) continue;

    found.push(img);
    if (found.length > 1) return null;
  }

  const only = found[0];
  if (!only) return null;

  const src = new URL(String(only.getAttribute('src')), url).href;
  const alt = attrValue(only.getAttribute('alt'));
  const title = attrValue(only.getAttribute('title'));

  return sanitizeHtml(
    `<p><img src="${attrValue(src)}" alt="${alt}"${title ? ` title="${title}"` : ''} /></p>`,
  );
}

/**
 * An attribute value safe to write into markup the sanitizer will then read.
 *
 * Stripping rather than escaping, which looks like the weaker choice and is the
 * right one here. The sanitizer escapes `&` on the way out without decoding on
 * the way in, so a value pre-escaped to `&quot;` is re-escaped to `&amp;quot;`
 * and the reader is shown the entity — an artist's `title="Mutt said &ldquo;no&rdquo;"`
 * arrives as literal punctuation soup. Emitting the raw text and letting the
 * sanitizer escape it exactly once is what renders correctly.
 *
 * What is left to do here is only what would break the attribute before the
 * sanitizer ever parsed it: the quote that would close it early, and the angle
 * brackets that would close the tag. Three characters, removed rather than
 * encoded, because an alt text missing a quotation mark is a smaller loss than
 * one covered in ampersands.
 *
 * @param {unknown} value
 * @returns {string}
 */
function attrValue(value) {
  return String(value ?? '').replace(/["<>]/g, '');
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
