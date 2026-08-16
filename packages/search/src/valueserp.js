/**
 * ValueSERP web search.
 *
 * Keyword discovery starts here: a keyword goes out to a search engine and a
 * page of ordinary web results comes back. Turning those results into feeds is
 * someone else's job — this module knows about search and nothing about RSS.
 */

const ENDPOINT = 'https://api.valueserp.com/search';

/**
 * Result pages fetched per keyword.
 *
 * Each page is a separate request and therefore a separate credit, so this is
 * the knob that decides what a hundred-keyword run costs: three pages is three
 * hundred credits.
 *
 * It exists because `num` does not work. The original script asked for
 * `num=100` and believed it was getting a hundred results per keyword; Google
 * stopped honouring that parameter, and a measured request for "siberian
 * huskies" comes back with eight organic results however large `num` is.
 * Pagination is now the only way to see past the first page, and page two is
 * entirely disjoint from page one.
 */
const DEFAULT_PAGES = 3;

/** Still sent, still ignored by the engine, still free to ask for. */
const NUM_RESULTS = 100;

const TIMEOUT_MS = 20_000;

/**
 * Errors that mean "stop the whole run", not "this one keyword failed".
 *
 * A dry account answers every subsequent search the same way, so a hundred
 * keywords would otherwise produce a hundred identical failures and a very
 * confusing status page.
 */
export const FATAL_ERRORS = new Set(['no-api-key', 'bad-api-key', 'quota-exhausted']);

/**
 * The API key, read at call time.
 *
 * Non-literal property access on purpose: Next inlines `process.env.FOO` at
 * build time, which would bake whatever the Docker build saw into the image.
 *
 * @returns {string} empty when unset
 */
export function apiKey() {
  return process.env['VALUESERP_API_KEY'] ?? '';
}

/**
 * Map a transport-level HTTP status to a stable error code.
 *
 * @param {number} status
 * @returns {string}
 */
function errorForStatus(status) {
  // ValueSERP answers 401 for a bad key and 402 once the month's credits are
  // spent. 402 is the one that matters operationally: the plan resets on a
  // fixed day of the month, so "quota-exhausted" is a wait, not a bug.
  if (status === 401 || status === 403) return 'bad-api-key';
  if (status === 402) return 'quota-exhausted';
  if (status === 429) return 'rate-limited';
  return `http-${status}`;
}

/**
 * Fetch one page of results for a keyword.
 *
 * @param {string} term
 * @param {number} page 1-based
 * @param {object} opts
 * @returns {Promise<{ ok: true, links: string[] } | { ok: false, error: string }>}
 */
async function searchPage(term, page, opts) {
  const doFetch = opts.fetchImpl ?? fetch;

  const url = new URL(ENDPOINT);
  url.searchParams.set('api_key', opts.key);
  url.searchParams.set('q', term);
  url.searchParams.set('gl', opts.gl ?? 'us');
  url.searchParams.set('hl', opts.hl ?? 'en');
  url.searchParams.set('num', String(opts.num ?? NUM_RESULTS));
  url.searchParams.set('page', String(page));
  // Unset by default. The original throwaway script pinned this to last_month,
  // which is right for news and wrong for blogs: a good blog that last posted
  // in March is still worth indexing.
  if (opts.timePeriod) url.searchParams.set('time_period', opts.timePeriod);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: errorForStatus(res.status) };

    const body = await res.json();
    const organic = Array.isArray(body?.organic_results) ? body.organic_results : [];

    const links = [];
    for (const row of organic) {
      const link = typeof row?.link === 'string' ? row.link : '';
      if (link) links.push(link);
    }

    return { ok: true, links };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : 'fetch-failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one keyword search, across as many result pages as configured.
 *
 * A page that fails after the first one is not fatal to the keyword: half the
 * results are worth more than none, and the failure is reported alongside them.
 *
 * @param {string} keyword
 * @param {{ apiKey?: string, pages?: number, num?: number, gl?: string, hl?: string, timePeriod?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: true, keyword: string, links: string[], pages: number } | { ok: false, keyword: string, error: string }>}
 */
export async function searchKeyword(keyword, opts = {}) {
  const term = String(keyword ?? '').trim();
  if (!term) return { ok: false, keyword: term, error: 'empty-keyword' };

  const key = opts.apiKey ?? apiKey();
  if (!key) return { ok: false, keyword: term, error: 'no-api-key' };

  const pages = Math.max(1, opts.pages ?? DEFAULT_PAGES);
  const settings = { ...opts, key };

  const links = [];
  const seen = new Set();
  let fetched = 0;

  for (let page = 1; page <= pages; page += 1) {
    const res = await searchPage(term, page, settings);

    if (!res.ok) {
      // The first page failing means the keyword produced nothing, and the
      // reason — quota, bad key — is the caller's to act on. A later page
      // failing just truncates the results.
      if (page === 1) return { ok: false, keyword: term, error: res.error };
      break;
    }

    fetched += 1;
    for (const link of res.links) {
      if (seen.has(link)) continue;
      seen.add(link);
      links.push(link);
    }

    // A short page is the last page; asking for the next one spends a credit to
    // be told the same thing.
    if (res.links.length === 0) break;
  }

  return { ok: true, keyword: term, links, pages: fetched };
}

// There is deliberately no searchKeywords() batch helper. Keywords are queued
// individually in the database and searched one at a time — by the request
// while its budget lasts, then by the poller — because each one has to record
// its own outcome and because a batch that runs to completion in memory is
// exactly what the queue exists to avoid.
