/**
 * Classify and count every request, so the free tier's ceiling can be a
 * measurement rather than a guess.
 *
 * The directory's traffic is known today only as one number from the platform,
 * and that number is the sum of three populations who want opposite things:
 *
 *   - people reading, who must never meet a rate limit;
 *   - agents calling the API and the MCP endpoint on purpose, which is the
 *     product working and the thing a sponsorship would eventually charge for;
 *   - scrapers walking every HTML page to reconstruct what /api/feeds would
 *     have handed them in one request, which is pure cost and no relationship.
 *
 * Only the third is worth throttling hard, and none of them can be told apart
 * from a total. Hence a classified counter.
 *
 * Two rules govern everything in this file. It never stores a raw user-agent or
 * an address -- only which family a caller belongs to, because a per-request log
 * of who read what is a different and much heavier thing to own. And it never
 * lets its own failure reach the request: a counter that can 500 a page is worse
 * than no counter.
 */

/**
 * User-agent families, most specific first.
 *
 * Order matters. Nearly every crawler also says "Mozilla/5.0", and several of
 * the commercial scrapers name a browser engine to blend in, so the browser test
 * has to come last and only after everything else has failed to match.
 *
 * The families are grouped the way a pricing decision needs them, not the way a
 * log viewer would: `ai-*` are the crawlers the robots.txt deliberately invites,
 * `seo-*` are the commercial link-graph scrapers that take and never send, and
 * `tool` is anything scripted. Splitting the AI crawlers by vendor is on purpose
 * -- "should we charge for this" is a question asked one vendor at a time.
 *
 * @type {Array<{ family: string, test: RegExp }>}
 */
const FAMILIES = [
  // The AI crawlers robots.txt names explicitly.
  { family: 'ai-openai', test: /gptbot|oai-searchbot|chatgpt-user/i },
  { family: 'ai-anthropic', test: /claudebot|claude-searchbot|claude-user|anthropic-ai/i },
  { family: 'ai-perplexity', test: /perplexitybot|perplexity-user/i },
  { family: 'ai-google', test: /google-extended|googleother/i },
  { family: 'ai-apple', test: /applebot-extended/i },
  { family: 'ai-meta', test: /meta-externalagent|facebookbot/i },
  { family: 'ai-bytedance', test: /bytespider/i },
  { family: 'ai-amazon', test: /amazonbot/i },
  { family: 'ai-commoncrawl', test: /ccbot/i },
  { family: 'ai-other', test: /diffbot|omgili|timpibot|imagesiftbot|youbot|cohere-ai/i },

  // Ordinary search indexing. Wanted: this is how people find the directory.
  { family: 'search-google', test: /googlebot|google-inspectiontool|storebot-google/i },
  { family: 'search-bing', test: /bingbot|adidxbot|msnbot/i },
  { family: 'search-other', test: /duckduckbot|yandexbot|baiduspider|slurp|applebot|petalbot|seznambot/i },

  // Commercial link-graph and SEO scrapers. These take the whole site and
  // return nothing to it -- the clearest candidates for the tightest bucket.
  {
    family: 'seo-scraper',
    test: /ahrefsbot|semrushbot|mj12bot|dotbot|dataforseo|blexbot|serpstat|rogerbot|screaming frog|sitebulb|zoominfobot|barkrowler|linkdexbot|megaindex/i,
  },

  // Feed readers, which are the directory's own subject matter.
  {
    family: 'feed-reader',
    test: /feedly|inoreader|newsblur|miniflux|freshrss|tt-rss|tiny tiny rss|netnewswire|reeder|feedbin|newsboat|liferea|rssowl|akregator|feedfetcher|granary|feedparser|rss-?bot|podcast|itunes|overcast|pocketcasts|antennapod/i,
  },

  // Scripted callers. Not necessarily hostile -- this is also what a small
  // agent written against the API looks like before anyone sets a UA.
  {
    family: 'tool',
    test: /curl|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|node-fetch|undici|axios|okhttp|java\/|libwww|scrapy|http_request|guzzle|postman|insomnia|lwp-|mechanize|colly|jsdom|puppeteer|playwright|headlesschrome|phantomjs/i,
  },

  // Everything that says it is a browser and nothing above claimed it. Left
  // last because most of the entries above also carry a Mozilla token.
  { family: 'browser', test: /mozilla|chrome|safari|firefox|edge|opera|webkit/i },
];

/**
 * Which family a user-agent belongs to.
 *
 * An absent UA gets its own bucket rather than folding into `other`: a caller
 * that sends none is either a bare script or something deliberately quiet, and
 * either way it is a distinct thing to price.
 *
 * @param {string | null | undefined} ua
 * @returns {string}
 */
export function classifyAgent(ua) {
  const value = (ua ?? '').trim();
  if (!value) return 'none';

  for (const { family, test } of FAMILIES) {
    if (test.test(value)) return family;
  }

  // A self-declared bot that matched no known name. Worth seeing as its own
  // line, because a new crawler showing up is exactly the event this table is
  // meant to catch.
  if (/bot|crawler|spider|scrape|fetch|agent/i.test(value)) return 'bot-unknown';

  return 'other';
}

/**
 * Which kind of route was asked for.
 *
 * Grouped by what a request *costs us*, not by URL shape. The reader is its own
 * bucket because it is the only path that may fetch and extract a third-party
 * page (and, on a cache miss, pay an LLM to translate it) -- one reader hit is
 * worth hundreds of directory pages, and a flat per-request limit prices them
 * identically.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function classifyPath(pathname) {
  const path = (pathname || '/').toLowerCase();

  if (path.startsWith('/_next/') || path.startsWith('/static/')) return 'asset';
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|css|js|map)$/.test(path)) return 'asset';

  if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp';

  // The cheap machine-readable entry points robots.txt advertises. A crawler
  // using these instead of walking the site is the outcome we want, so they are
  // counted apart from both `api` and `page` to make that visible.
  if (
    path === '/llms.txt' ||
    path === '/skill.md' ||
    path === '/robots.txt' ||
    path === '/opml' ||
    path.startsWith('/opml/') ||
    path.startsWith('/sitemap') ||
    path.endsWith('.rss') ||
    path.endsWith('.xml') ||
    path.endsWith('.json') ||
    path.endsWith('/feed')
  ) {
    return 'export';
  }

  if (path.startsWith('/api/auth/') || path === '/login' || path.startsWith('/auth/')) return 'auth';
  if (path.startsWith('/api/')) return 'api';

  // Expensive: fetches, extracts and possibly translates somebody else's page.
  if (path.endsWith('/read') || path.includes('/read?') || path.startsWith('/read/')) return 'reader';

  if (path === '/search' || path.startsWith('/search/')) return 'search';

  return 'page';
}

/**
 * The counter itself: (hour, agent, bucket) -> hits, held in memory and folded
 * into the rollup on a timer.
 *
 * In memory because the write path is the scarce resource on this database. A
 * row per request would be tens of thousands of transactions an hour competing
 * with the crawler for one lock, on a database where an empty write can already
 * take half a minute under load. A minute of buffering turns that into one
 * batch of a few dozen upserts, and the only thing lost is a minute's counters
 * if the process dies -- which, for choosing a rate limit, is nothing.
 *
 * Multiple instances each keep their own buffer and the upsert accumulates, so
 * this stays correct if the service ever scales past one container.
 *
 * @type {Map<string, number>}
 */
const buffer = new Map();

/**
 * Key separator.
 *
 * A character that cannot occur in any of the four parts, so splitting a key
 * back apart cannot go wrong. Every part is drawn from a fixed vocabulary in
 * this file except `hour`, which is an ISO prefix — none of them can contain a
 * NUL, and picking something they *could* contain is how a key silently splits
 * into the wrong number of fields.
 */
const SEP = ' ';

/** Above this many distinct keys, stop adding new ones rather than grow without bound. */
const MAX_KEYS = 5_000;

/** How often the buffer is folded into the rollup. */
const FLUSH_MS = 60_000;

let flushTimer = null;
let flushing = false;

/**
 * Count one request.
 *
 * @param {{ hour: string, agent: string, bucket: string }} hit
 * @returns {void}
 */
export function record({ hour, agent, bucket, tier }) {
  const key = [hour, agent, bucket, tier].join(SEP);
  const existing = buffer.get(key);

  if (existing === undefined && buffer.size >= MAX_KEYS) return;
  buffer.set(key, (existing ?? 0) + 1);
}

/**
 * Take everything counted so far, leaving the buffer empty.
 *
 * Drains before writing rather than after, so a request arriving mid-flush is
 * counted into the next window instead of being dropped or double-counted.
 *
 * @returns {Array<{ hour: string, agent: string, bucket: string, hits: number }>}
 */
export function drain() {
  const rows = [];
  for (const [key, hits] of buffer) {
    const [hour, agent, bucket, tier] = key.split(SEP);
    rows.push({ hour, agent, bucket, tier, hits });
  }
  buffer.clear();
  return rows;
}

/**
 * Fold the buffer into the rollup.
 *
 * Never throws. On a failed write the counters are already gone -- deliberately,
 * because the alternative is putting them back and retrying into a database that
 * is evidently busy, which is how a bookkeeping timer turns into an outage.
 *
 * @param {(rows: Array<{ hour: string, agent: string, bucket: string, hits: number }>) => Promise<unknown>} write
 * @returns {Promise<void>}
 */
export async function flush(write) {
  if (flushing) return;
  flushing = true;

  try {
    const rows = drain();
    if (rows.length > 0) await write(rows);
  } catch {
    // Housekeeping lost, not a request lost.
  } finally {
    flushing = false;
  }
}

/**
 * Start the flush timer, once per process.
 *
 * Unref'd so it never holds the process open on its own.
 *
 * @param {(rows: Array<{ hour: string, agent: string, bucket: string, hits: number }>) => Promise<unknown>} write
 * @returns {void}
 */
export function startFlushing(write) {
  if (flushTimer) return;

  flushTimer = setInterval(() => {
    void flush(write);
  }, FLUSH_MS);

  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** Test seam. @returns {void} */
export function reset() {
  buffer.clear();
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  flushing = false;
}
