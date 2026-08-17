import { parseHTML } from 'linkedom';

import { safeFetch } from './fetch.js';
import { KIND_BLOG } from './kinds.js';
import { summarize } from './parse.js';

/**
 * Building a feed for a site that publishes none.
 *
 * Every other path in this directory starts from a document the publisher wrote
 * to be read by machines. This one starts from a page written for people, which
 * means there is no correct answer available — only a well-supported guess. So
 * the ordering below is precision-first: a site that states its posts in
 * JSON-LD is believed, a site that marks them up as <article> is believed, and
 * only a site that does neither gets the structural heuristic, which is the one
 * that can be wrong.
 *
 * The gates at the bottom matter more than the extraction. A directory of
 * 47,000 hand-vouched feeds is worth something precisely because it is not full
 * of nav bars parsed as blog posts, and a scraper that returns its best effort
 * on every page would fill it with exactly that. Returning `no-posts-found` is
 * the common, correct outcome for most of the web, and this module is written
 * to reach that verdict cheaply rather than to avoid it.
 *
 * What this is not: a crawler. One page is fetched, the links on it are read,
 * and nothing behind them is followed — the post bodies stay unread until a
 * human opens one in the reader, which is what `extract.js` is for.
 */

/**
 * Fewest posts a page must yield before it is called a feed.
 *
 * Three is the smallest number that can establish a repeating pattern. Two
 * matching elements are a coincidence — a header and a footer, a pair of
 * call-to-action cards — and admitting them would turn every landing page on
 * the web into a two-post blog.
 */
const MIN_POSTS = 3;

/**
 * Shortest link text that can be a post title.
 *
 * Site furniture is short by design: "Home", "About", "Next", "Read more", "»".
 * Titles are long because they have to say what the post is about. This single
 * threshold removes most navigation without needing to know what navigation
 * looks like on any particular site.
 */
const MIN_TITLE_LENGTH = 12;

/** Cap on how many posts one page contributes, mirroring a feed's own window. */
const MAX_POSTS = 40;

/**
 * Link text that is furniture even when it is long enough to pass the length
 * gate. Kept short deliberately: this is a backstop for the few phrases that
 * recur across the whole web, not a per-site blocklist.
 */
const FURNITURE =
  /^(?:read(?: more| the rest)?|continue reading|older posts?|newer posts?|next page|previous page|subscribe|sign (?:up|in)|log ?in|contact(?: us)?|privacy policy|terms(?: of service)?|back to top|view all|see all|learn more|share this)\b/i;

/**
 * Containers whose links are never posts.
 *
 * A blog's nav and its post list are frequently the same shape — a list of
 * links, each in an <li> — so the structural heuristic cannot tell them apart
 * on form alone. The document says which is which, and it is worth believing.
 */
const CHROME = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM']);

/**
 * Collapse the whitespace an HTML document is free to scatter through text.
 *
 * @param {string} v
 * @returns {string}
 */
function clean(v) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * An ISO timestamp, or null when the value is not a date.
 *
 * Matches the parser's convention exactly: items carry `publishedAt: null`
 * rather than an empty string when nothing dated them, because "undated" and
 * "dated to the epoch" sort very differently.
 *
 * @param {unknown} v
 * @returns {string|null}
 */
function toIso(v) {
  const raw = clean(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Resolve an href against the page it was found on.
 *
 * @param {string} href
 * @param {string} baseUrl
 * @returns {string} absolute http(s) URL, or '' if it is not one
 */
function absolute(href, baseUrl) {
  const raw = clean(href);
  if (!raw || raw.startsWith('#')) return '';
  try {
    const u = new URL(raw, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * Is this text a plausible post title rather than a piece of site furniture?
 *
 * @param {string} title
 * @returns {boolean}
 */
function usableTitle(title) {
  if (title.length < MIN_TITLE_LENGTH) return false;
  if (FURNITURE.test(title)) return false;
  return true;
}

/**
 * Is this element inside a single post rather than inside a list of them?
 *
 * Reached only when the page did not yield three top-level <article> elements,
 * which means it is not an index — most often it is one post's own permalink
 * page. Repeated structure inside a post is its comment thread, its footnotes
 * or its "related posts" strip, and every one of those repeats exactly as
 * neatly as a post list does. Refusing the whole region is the cheap way to be
 * sure a comment thread never becomes a blog.
 *
 * The cost is a site whose index page wraps its list in <article>, which is
 * unusual markup; the alternative cost is comment threads in the directory,
 * which is unacceptable. Precision wins.
 *
 * @param {any} el
 * @returns {boolean}
 */
function insidePost(el) {
  for (let node = el; node; node = node.parentElement) {
    if (node.tagName === 'ARTICLE') return true;
  }
  return false;
}

/**
 * Does this element sit inside site chrome?
 *
 * @param {any} el
 * @returns {boolean}
 */
function inChrome(el) {
  for (let node = el; node; node = node.parentElement) {
    if (CHROME.has(node.tagName)) return true;
    const role = node.getAttribute?.('role');
    if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return true;
  }
  return false;
}

/**
 * A structural fingerprint for one element, used to spot repetition.
 *
 * Digits are stripped from class names because the repetition being looked for
 * is usually numbered by the CMS — `post-1041`, `item-2`, `entry-odd-3` — and
 * two posts that differ only by their id are the strongest possible evidence
 * that this is a list of posts.
 *
 * @param {any} el
 * @returns {string}
 */
function signature(el) {
  const classes = clean(el.getAttribute('class') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((c) => c.replace(/\d+/g, ''))
    .sort()
    .join('.');
  return `${el.tagName}|${classes}`;
}

/**
 * Pull the one link that represents a post out of its container.
 *
 * A post card carries several links — the title, the author, the tags, a
 * comment count — and only one of them is the post. The heading is asked first
 * because a card that has one is telling us where its subject is; the length
 * test is the fallback for cards built entirely out of divs.
 *
 * @param {any} el
 * @param {string} baseUrl
 * @returns {{ url: string, title: string }|null}
 */
function postLink(el, baseUrl) {
  // The oldest blog index on the web is a run of sibling <a> elements separated
  // by <br>, with no per-post container at all — paulgraham.com/articles.html
  // is the canonical example. There the repeated element *is* the link, so
  // asking it for a descendant anchor finds nothing and the page reads as
  // empty. These sites are exactly the ones that never published a feed, so
  // handling the shape is most of the point of scraping at all.
  if (el.tagName === 'A' && el.hasAttribute('href')) {
    const url = absolute(el.getAttribute('href'), baseUrl);
    const title = clean(el.textContent);
    return url && usableTitle(title) ? { url, title } : null;
  }

  const heading = el.querySelector('h1 a[href], h2 a[href], h3 a[href], h4 a[href]');
  const candidates = heading ? [heading] : [...el.querySelectorAll('a[href]')];

  for (const a of candidates) {
    const url = absolute(a.getAttribute('href'), baseUrl);
    if (!url) continue;

    // The heading link is trusted on its position rather than its length: a
    // genuinely terse post title ("On Rest") is still the post.
    const title = clean(a.textContent);
    if (a === heading ? title.length > 0 : usableTitle(title)) return { url, title };
  }

  // A card whose heading is not itself a link still names the post in that
  // heading, with the anchor wrapping the whole card.
  const wrapper = el.matches?.('a[href]') ? el : el.querySelector('a[href]');
  const headingText = clean(el.querySelector('h1, h2, h3, h4')?.textContent ?? '');
  if (wrapper && usableTitle(headingText)) {
    const url = absolute(wrapper.getAttribute('href'), baseUrl);
    if (url) return { url, title: headingText };
  }

  return null;
}

/**
 * Build one item from the container that holds it.
 *
 * @param {any} el
 * @param {string} baseUrl
 * @returns {object|null}
 */
function itemFrom(el, baseUrl) {
  const link = postLink(el, baseUrl);
  if (!link) return null;
  if (!usableTitle(link.title)) return null;

  // A page that links to itself at the top of its own post list is describing
  // the list, not an entry in it.
  if (link.url === baseUrl) return null;

  const time = el.querySelector('time');
  const publishedAt =
    toIso(time?.getAttribute('datetime')) ??
    toIso(time?.textContent) ??
    toIso(el.querySelector('[datetime]')?.getAttribute('datetime'));

  // The first paragraph that is not simply the title repeated. Cards often
  // restate the headline in a <p>, and echoing it into the summary makes every
  // entry read twice.
  let summary = '';
  for (const p of el.querySelectorAll('p')) {
    const t = clean(p.textContent);
    if (t && t !== link.title && t.length >= 20) {
      summary = t;
      break;
    }
  }

  const img = el.querySelector('img[src]');

  return {
    // The post's own URL. Stable across re-crawls in a way that nothing else
    // available here is: positions shift as the site publishes, and titles get
    // edited, but the permalink is what makes this post this post.
    guid: link.url,
    url: link.url,
    title: link.title,
    summary: summary ? summarize(summary) : '',
    // Left empty on purpose. All that is available here is the excerpt the
    // index page chose to show, and storing that as the body would make the
    // reader render a truncated teaser as though it were the article. The
    // reader fetches the real page on demand instead — see extract.js.
    contentHtml: '',
    author: '',
    publishedAt,
    imageUrl: img ? absolute(img.getAttribute('src'), baseUrl) : '',
    categories: [],
    audio: null,
  };
}

/**
 * Drop duplicates and anything that failed a gate, preserving document order.
 *
 * Deliberately does not apply MAX_POSTS. The cluster heuristic judges a group
 * by what fraction of its members yielded a post, and a cap applied here would
 * corrupt that ratio precisely for the pages it should like most: a 198-entry
 * archive truncated to 40 scores 0.20 and gets thrown away for being too long.
 * The cap belongs at the end, once every decision has been made.
 *
 * @param {Array<object|null>} items
 * @returns {object[]}
 */
function tidy(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

/**
 * Posts a page states outright in JSON-LD.
 *
 * The highest-precision source available, and the only one here that is not a
 * guess: the publisher has written down which things on this page are posts,
 * where they live and when they went out. Most CMS themes emit it.
 *
 * @param {any} document
 * @param {string} baseUrl
 * @returns {object[]}
 */
export function postsFromJsonLd(document, baseUrl) {
  /** @type {any[]} */
  const nodes = [];

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent ?? '');
      nodes.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // One malformed block must not cost us the others. Hand-written JSON-LD
      // with a trailing comma is common enough to be worth surviving.
    }
  }

  /** @type {any[]} */
  const entries = [];

  const collect = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (Array.isArray(node)) {
      for (const n of node) collect(n, depth + 1);
      return;
    }

    // @graph is how most generators wrap a page's several statements.
    if (node['@graph']) collect(node['@graph'], depth + 1);
    if (node.blogPost) collect(node.blogPost, depth + 1);
    if (node.itemListElement) collect(node.itemListElement, depth + 1);
    // A ListItem wraps the thing it lists.
    if (node.item) collect(node.item, depth + 1);

    const type = String(node['@type'] ?? '');
    if (/BlogPosting|Article|NewsArticle|Report|WebPage/i.test(type)) entries.push(node);
  };

  collect(nodes);

  const items = entries.map((node) => {
    const url = absolute(node.url ?? node['@id'] ?? '', baseUrl);
    const title = clean(node.headline ?? node.name ?? '');
    if (!url || !usableTitle(title) || url === baseUrl) return null;

    const image = node.image;
    const imageUrl = absolute(
      typeof image === 'string' ? image : (image?.url ?? image?.[0]?.url ?? image?.[0] ?? ''),
      baseUrl,
    );

    return {
      guid: url,
      url,
      title,
      summary: summarize(clean(node.description ?? node.abstract ?? '')),
      contentHtml: '',
      author: clean(node.author?.name ?? node.author?.[0]?.name ?? ''),
      publishedAt: toIso(node.datePublished ?? node.dateCreated ?? node.dateModified),
      imageUrl,
      categories: [],
      audio: null,
    };
  });

  return tidy(items);
}

/**
 * Posts a page marks up semantically.
 *
 * <article> means "an independent, self-contained composition", which on an
 * index page is exactly a post. Believed on the same footing as JSON-LD, and
 * checked second only because JSON-LD carries dates more reliably.
 *
 * @param {any} document
 * @param {string} baseUrl
 * @returns {object[]}
 */
export function postsFromArticles(document, baseUrl) {
  const articles = [...document.querySelectorAll('article')].filter((el) => !inChrome(el));
  if (articles.length < MIN_POSTS) return [];

  // A single post's page is also marked up with <article>, and its comments are
  // frequently articles too. Nested ones are dropped so a comment thread cannot
  // be read as a blog.
  const outermost = articles.filter((el) => !articles.some((o) => o !== el && o.contains(el)));
  if (outermost.length < MIN_POSTS) return [];

  return tidy(outermost.map((el) => itemFrom(el, baseUrl)));
}

/**
 * Posts inferred from repeated structure.
 *
 * The fallback for sites that say nothing about what they publish, which is
 * most hand-built ones. A post list is the largest group of sibling elements
 * that share a shape and each contain a substantial link, so that is what gets
 * looked for — and then scored, because a page usually contains several such
 * groups and only one of them is the posts.
 *
 * @param {any} document
 * @param {string} baseUrl
 * @returns {object[]}
 */
export function postsFromClusters(document, baseUrl) {
  /** @type {{ items: object[], score: number }[]} */
  const candidates = [];

  for (const parent of document.querySelectorAll('*')) {
    const kids = [...parent.children];
    if (kids.length < MIN_POSTS) continue;
    if (inChrome(parent)) continue;
    if (insidePost(parent)) continue;

    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const kid of kids) {
      const sig = signature(kid);
      const group = groups.get(sig);
      if (group) group.push(kid);
      else groups.set(sig, [kid]);
    }

    for (const group of groups.values()) {
      if (group.length < MIN_POSTS) continue;

      // Only siblings that carry a link can be posts, so only they are evidence
      // either way. Table layouts from the era before CSS alternate a content
      // row with an empty spacer row — paulgraham.com/articles.html is 466 rows
      // for 233 essays — and counting those spacers as failures put a genuine
      // archive at exactly 0.50 and threw it away.
      const bearing = group.filter((el) =>
        el.tagName === 'A' ? el.hasAttribute('href') : Boolean(el.querySelector('a[href]')),
      );
      if (bearing.length < MIN_POSTS) continue;

      const items = tidy(bearing.map((el) => itemFrom(el, baseUrl)));
      // Most of the link-bearing siblings must actually have yielded a post. A
      // nav list where one entry happens to have a long label is not a post
      // list, and this ratio is what separates the two — its members all carry
      // links, so they stay in the denominator and drag it down.
      if (items.length < MIN_POSTS) continue;
      if (items.length / bearing.length < 0.6) continue;

      // Dated entries are the single strongest signal that a list is a
      // chronology rather than a menu, so they are worth more than mere count.
      const dated = items.filter((i) => i.publishedAt).length;
      candidates.push({ items, score: items.length + dated * 2 });
    }
  }

  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].items;
}

/**
 * The feed-level metadata a page carries about itself.
 *
 * @param {any} document
 * @param {string} pageUrl
 * @returns {{ title: string, description: string, siteUrl: string, language: string, imageUrl: string }}
 */
function siteMeta(document, pageUrl) {
  const meta = (selector, attr = 'content') =>
    clean(document.querySelector(selector)?.getAttribute(attr) ?? '');

  const host = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();

  const title =
    meta('meta[property="og:site_name"]') ||
    clean(document.querySelector('title')?.textContent ?? '') ||
    host;

  return {
    title: title || '(untitled)',
    description: summarize(
      meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      500,
    ),
    siteUrl: pageUrl,
    language: clean(document.documentElement?.getAttribute('lang') ?? '').slice(0, 12),
    imageUrl: absolute(meta('meta[property="og:image"]'), pageUrl),
  };
}

/**
 * Read a page's post list without fetching anything.
 *
 * Split out from `scrapeFeed` so the whole decision — which strategy wins, and
 * whether the result clears the gates — is testable against fixture HTML.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{ ok: true, feed: object } | { ok: false, error: string }}
 */
export function buildFeedFromPage(html, pageUrl) {
  if (typeof html !== 'string' || html.length === 0) {
    return { ok: false, error: 'empty-page' };
  }

  /** @type {any} */
  let document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return { ok: false, error: 'unparseable-page' };
  }

  // Precision order: stated, then marked up, then inferred.
  const items =
    firstNonEmpty(
      () => postsFromJsonLd(document, pageUrl),
      () => postsFromArticles(document, pageUrl),
      () => postsFromClusters(document, pageUrl),
    ) ?? [];

  if (items.length < MIN_POSTS) return { ok: false, error: 'no-posts-found' };

  return {
    ok: true,
    feed: {
      ...siteMeta(document, pageUrl),
      // Capped only now, so that every gate above judged the real list.
      categories: [],
      // Everything built here is read off a page of prose links. Audio and
      // video sites announce themselves through enclosures, which a scrape by
      // definition does not have, so claiming any other kind would be a guess
      // on top of a guess.
      kind: KIND_BLOG,
      items: items.slice(0, MAX_POSTS),
    },
  };
}

/**
 * Return the first strategy's result that produced anything.
 *
 * @param {...(() => object[])} strategies
 * @returns {object[]|null}
 */
function firstNonEmpty(...strategies) {
  for (const run of strategies) {
    const out = run();
    if (out.length >= MIN_POSTS) return out;
  }
  return null;
}

/**
 * Fetch a page and build a feed out of it.
 *
 * Deliberately not wired into `resolveFeed`. Scraping is a different claim from
 * parsing — it can be wrong, and it costs a DOM — so the caller states that it
 * wants one. That also keeps a feed that is merely down for the afternoon from
 * being silently converted into a scraped page by a passing re-crawl.
 *
 * Returns the same shape as `resolveFeed` so that everything downstream —
 * storage, topics, syndication — cannot tell the difference.
 *
 * @param {string} input a page URL
 * @returns {Promise<{ ok: true, feedUrl: string, feed: object } | { ok: false, error: string }>}
 */
export async function scrapeFeed(input) {
  const res = await safeFetch(input);
  if (!res.ok) return { ok: false, error: res.error ?? `http-${res.status}` };

  const built = buildFeedFromPage(res.body, res.url);
  if (!built.ok) return built;

  // The page itself is the feed URL. There is no other stable identifier for a
  // source that publishes no feed, and it is what a re-crawl must fetch.
  return { ok: true, feedUrl: res.url, feed: built.feed };
}
