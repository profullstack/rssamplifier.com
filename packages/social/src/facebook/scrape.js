import { parseHTML } from 'linkedom';

import { providerGet } from '../x/providers/http.js';
import { XAuthFailed, XNoSuchSource, XUnavailable } from '../x/errors.js';

/**
 * Reading a Facebook Page the way the rest of this package reads X and
 * Instagram: with a logged-in session, off the HTML.
 *
 * **Why this exists after `./fetch.js` said it would not.** The Graph API path
 * next door works and needs no scraping, but it only ever reaches Pages the
 * caller administers, which makes `/fb/` a namespace almost nobody can add to.
 * The rest of the directory does not work that way, and neither do the other
 * two collected platforms: X is read with an `auth_token` cookie and Instagram
 * with an `IG_COOKIE`. A session cookie here is the same bargain, not a new one.
 *
 * **`mbasic.facebook.com`, not `www`.** It is the no-JavaScript version, so a
 * page is server-rendered HTML that a parser can read — where `www` is a React
 * application whose content arrives in GraphQL payloads and whose class names
 * are generated afresh on every deploy. mbasic still answers (measured
 * 2026-08-29: it 302s to `login.php` without a session rather than 404ing, which
 * is what tells you it is alive and gated rather than gone).
 *
 * ## What this is honestly worth
 *
 * Less than the other two, and the difference is worth stating plainly rather
 * than discovering in production:
 *
 * - **Nobody maintains this shape but us.** RSSHub carries a thousand
 *   namespaces and keeps Twitter and Instagram working; it has no Facebook one.
 *   That is not an oversight, it is a verdict — Facebook is the most hostile of
 *   the three to automation, and the tooling ecosystem reflects it.
 * - **It will break**, and on Facebook's schedule rather than ours. Every
 *   selector below is a guess about somebody else's markup. They are collected
 *   in `SELECTORS` so that fixing them is one edit in one place.
 * - **The account will be challenged.** Expect checkpoints, and expect them
 *   sooner if this polls quickly — which is why Facebook gets its own, much
 *   slower interval rather than the five minutes X gets.
 *
 * None of that is a reason not to build it. It is a reason for the failure
 * handling below to be careful: a checkpoint must retire the *session*, never
 * the Page, or one bad afternoon deletes the namespace.
 */

/** The mobile HTML host. The only one of the three that renders server-side. */
const MBASIC = 'https://mbasic.facebook.com';

/**
 * A phone, because mbasic serves its simplest markup to one.
 *
 * Not a disguise — the crawler identifies itself in `providerGet`'s default
 * agent everywhere it is not required to look like a browser. Here the user
 * agent selects a *rendering*, and asking for the desktop one gets a page this
 * parser cannot read.
 */
const UA = 'Mozilla/5.0 (Android 10; Mobile; rv:109.0) Gecko/109.0 Firefox/115.0';

/**
 * Everything that depends on Facebook's markup, in one place.
 *
 * When this stops working — and it will — the fix is almost certainly here and
 * nowhere else. Fetch a page with a live cookie, look at the HTML, and update
 * the list. Each is tried in order and the first that matches wins, so an old
 * selector can be left in place while a new one is added above it.
 */
const SELECTORS = {
  /** A post. mbasic marks each story with a `data-ft` JSON blob. */
  post: ['div[data-ft*="top_level_post_id"]', 'div[data-ft*="mf_story_key"]', 'article'],
  /** The prose inside one. The first non-empty match is taken as the caption. */
  text: ['div[data-ft] > div > span', 'div[data-ft] > div > div > span', 'p'],
  /** The permalink, which also carries the post id. */
  link: ['a[href*="/story.php?story_fbid="]', 'a[href*="/posts/"]', 'a[href*="story_fbid"]'],
  /** The timestamp. mbasic still uses <abbr>, which is the only date on offer. */
  time: ['abbr'],
  /** An attached photo. */
  image: ['img[src*="scontent"]', 'img'],
};

/**
 * Is the response the login wall rather than the page?
 *
 * Checked on the final URL and on the body, because the redirect and the
 * interstitial are two different ways of being told the same thing.
 */
const LOGIN_WALL = /\/login\.php|\/login\/\?|name="login"|checkpoint/i;

/**
 * Scrape one Page.
 *
 * @param {{ page: string }} spec
 * @param {{
 *   cookie: string,
 *   timeoutMs?: number,
 *   fetch?: typeof fetch,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{ posts: Array<object>, displayName: string|null }>}
 */
export async function scrapeFacebookPage(spec, opts) {
  if (!opts?.cookie) {
    throw new XUnavailable('facebook: no session (FB_COOKIE is not set)');
  }

  const url = `${MBASIC}/${encodeURIComponent(spec.page)}`;

  const { body, url: landed } = await providerGet(url, {
    provider: 'facebook-mbasic',
    headers: {
      cookie: opts.cookie,
      'user-agent': UA,
      // mbasic serves a different, heavier page to a client that claims to
      // want the modern one.
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    timeoutMs: opts.timeoutMs,
    fetch: opts.fetch,
    signal: opts.signal,
  });

  // The session is gone, or Facebook wants a challenge solved. Either way it is
  // a fact about our login and not about this Page — `failureResult` routes
  // XAuthFailed to a reschedule, and the session pool retires the credential.
  // Blaming the Page here is how ten crawls delete the namespace.
  if (LOGIN_WALL.test(String(landed ?? '')) || LOGIN_WALL.test(body.slice(0, 4000))) {
    throw new XAuthFailed('facebook: session rejected (login or checkpoint)');
  }

  const { document } = parseHTML(body);

  // Facebook answers a missing Page with a real page saying so, not a 404.
  if (/isn't available|content isn't available|page you requested|couldn't find/i.test(body.slice(0, 20_000))) {
    throw new XNoSuchSource(`facebook: no such page ${spec.page}`);
  }

  const nodes = firstMatch(document, SELECTORS.post);
  const posts = [...nodes].map((node) => toPost(node, spec)).filter(Boolean);

  return { posts, displayName: displayName(document) };
}

/**
 * The first selector in a list that matches anything.
 *
 * The list is a fallback chain rather than a union, so a newer selector can be
 * added above an older one without the two both matching and doubling every
 * post.
 */
function firstMatch(root, selectors) {
  for (const selector of selectors) {
    const found = root.querySelectorAll(selector);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * One story element as a post.
 *
 * @param {any} node
 * @param {{ page: string }} spec
 */
function toPost(node, spec) {
  const id = postId(node);

  // No id, no post. An item that cannot be deduplicated arrives again on every
  // crawl for ever, which is invisible until the feed is nothing but
  // duplicates — the same rule the X and Instagram collectors apply.
  if (!id) return null;

  const link = firstMatch(node, SELECTORS.link)[0];
  const href = link?.getAttribute?.('href') ?? null;

  const text = [...firstMatch(node, SELECTORS.text)]
    .map((el) => String(el.textContent ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();

  const time = firstMatch(node, SELECTORS.time)[0];
  const image = firstMatch(node, SELECTORS.image)[0]?.getAttribute?.('src') ?? null;

  return {
    id,
    url: absolute(href) ?? `https://www.facebook.com/${spec.page}`,
    text,
    // mbasic writes a human date ("Yesterday at 14:03"). `Date.parse` handles
    // the absolute forms and returns NaN for the relative ones, which becomes
    // null — and a null date is correct rather than a guess. The crawler's
    // cadence code already copes with an undated feed; inventing "now" for
    // every post would make the feed look permanently fresh, which is the one
    // failure `publishedTimes` exists to prevent.
    createdAt: parseDate(time?.getAttribute?.('data-utime'), time?.textContent),
    image: image && image.startsWith('http') ? image : null,
  };
}

/**
 * The post id, from the `data-ft` blob mbasic attaches to each story.
 *
 * Read from the attribute rather than from the permalink, because the permalink
 * varies (`/story.php?story_fbid=`, `/<page>/posts/<id>`) while this does not —
 * and because a Page rename rewrites every permalink it has ever had, so a
 * URL-keyed identity would re-ingest the whole Page the day that happens.
 */
function postId(node) {
  const raw = node?.getAttribute?.('data-ft');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const id = parsed?.top_level_post_id ?? parsed?.mf_story_key;
      if (id) return String(id);
    } catch {
      // Fall through to the link.
    }
  }

  const href = firstMatch(node, SELECTORS.link)[0]?.getAttribute?.('href') ?? '';
  return /story_fbid=(\d+)/.exec(href)?.[1] ?? /\/posts\/(\d+)/.exec(href)?.[1] ?? null;
}

/** The Page's own name, for the feed title. */
function displayName(document) {
  const title = String(document.querySelector('title')?.textContent ?? '').trim();
  if (!title) return null;
  // mbasic titles are "<Page Name> - Home | Facebook" and similar.
  return title.replace(/\s*[-|]\s*(Home\s*)?\|?\s*Facebook\s*$/i, '').trim() || null;
}

/**
 * @param {string|null|undefined} utime epoch seconds, when mbasic gives one
 * @param {string|null|undefined} text the human date otherwise
 * @returns {string|null} ISO 8601
 */
function parseDate(utime, text) {
  const seconds = Number(utime);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toISOString();

  const parsed = Date.parse(String(text ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** mbasic links are relative and point at mbasic; ours must point at Facebook. */
function absolute(href) {
  if (!href) return null;
  const path = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
  return path.replace('//mbasic.facebook.com', '//www.facebook.com').split('&refid')[0];
}
