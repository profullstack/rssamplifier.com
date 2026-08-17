/**
 * ValueSERP web search.
 *
 * Keyword discovery starts here: a keyword goes out to a search engine and a
 * page of ordinary web results comes back. Turning those results into feeds is
 * someone else's job — this module knows about search and nothing about RSS.
 */

const ENDPOINT = 'https://api.valueserp.com/search';

/**
 * Results asked for per page.
 *
 * Ten, because ten is what the engine serves and — this is the part that cost
 * us ninety results a keyword — because `num` is not ignored. It sets the
 * stride `page` walks in: the offset sent upstream is `(page - 1) * num`. Ask
 * for `num=100` and page two starts at result 101, which is past the end of a
 * result set Google truncates long before then, so it comes back empty and
 * pagination stops after one page.
 *
 * Measured against the live API on 2026-08-17, same keyword, same account:
 *
 *   "prepping"         num=100 →  9 unique, dry at page 2
 *                      num=10  → 87 unique over 10 pages
 *   "smokey mountains" num=100 → 17 unique, dry at page 3
 *                      num=10  → 90 unique over 11 pages
 *
 * So the old constant did not merely fail to raise the page size; it capped
 * every keyword at its first page.
 */
const PAGE_SIZE = 10;

/**
 * Unique results collected per keyword before stopping.
 *
 * A hundred is the whole first hundred of Google's ranking, which is as deep as
 * this is worth taking: past that the results stop being about the keyword.
 */
export const TARGET_RESULTS = 100;

/**
 * Pages fetched per keyword, at most.
 *
 * Twelve rather than ten because page one reliably comes back short — seven to
 * nine organic results, not ten — and pages repeat each other's links, so a
 * hundred unique results needs eleven or twelve pages in practice.
 *
 * Each page is a credit. A keyword now costs up to twelve of them against the
 * metered monthly plan, where it used to cost three.
 */
const MAX_PAGES = 12;

/**
 * Pages in flight at once.
 *
 * Sequential paging cannot reach a hundred results inside any budget a person
 * or a poller tick will tolerate: measured page times range from 3s to 34s, so
 * twelve pages in a row is a worst case of several minutes for one keyword. The
 * account's limit is 250 requests a minute, so four at a time is nowhere near
 * pressure — it is simply the width at which a keyword finishes in about the
 * time its slowest page takes.
 *
 * It is also the bound on waste: a wave that runs past the end of the results
 * spends at most this many credits learning that.
 */
const PAGE_CONCURRENCY = 4;

/**
 * How long one page may take.
 *
 * Measured pages have taken 34s. The old 20s cut in below that, which is what
 * killed the "smokey mountains" keyword on run c1bb1503 — a keyword marked
 * failed for no reason but the provider being slow that minute.
 */
const TIMEOUT_MS = 45_000;

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
  url.searchParams.set('num', String(opts.num ?? PAGE_SIZE));
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
 * Fetch page one, retrying once if the provider was merely slow.
 *
 * Only page one, and only for the two errors that mean "no answer" rather than
 * "an answer you won't like": everything downstream treats a failed first page
 * as the keyword producing nothing, so a single slow response is the difference
 * between ninety results and a keyword marked failed.
 *
 * @param {string} term
 * @param {object} opts
 * @returns {Promise<{ ok: true, links: string[] } | { ok: false, error: string }>}
 */
async function searchFirstPage(term, opts) {
  const first = await searchPage(term, 1, opts);
  if (first.ok || (first.error !== 'timeout' && first.error !== 'fetch-failed')) return first;

  return searchPage(term, 1, opts);
}

/**
 * Run one keyword search, paging until it has a hundred results.
 *
 * Page one goes out alone — it decides whether the keyword produced anything at
 * all, and there is no sense spending four credits to find out the account is
 * dry. The rest go out in waves, and the walk stops at whichever comes first:
 * the target, a page with nothing on it, or the page cap.
 *
 * A page that fails after the first one is not fatal to the keyword: half the
 * results are worth more than none, and the failure is reported alongside them.
 *
 * @param {string} keyword
 * @param {{ apiKey?: string, pages?: number, target?: number, concurrency?: number, num?: number, gl?: string, hl?: string, timePeriod?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: true, keyword: string, links: string[], pages: number } | { ok: false, keyword: string, error: string }>}
 */
export async function searchKeyword(keyword, opts = {}) {
  const term = String(keyword ?? '').trim();
  if (!term) return { ok: false, keyword: term, error: 'empty-keyword' };

  const key = opts.apiKey ?? apiKey();
  if (!key) return { ok: false, keyword: term, error: 'no-api-key' };

  const maxPages = Math.max(1, opts.pages ?? MAX_PAGES);
  const target = Math.max(1, opts.target ?? TARGET_RESULTS);
  const width = Math.max(1, opts.concurrency ?? PAGE_CONCURRENCY);
  const settings = { ...opts, key };

  const links = [];
  const seen = new Set();
  let fetched = 0;

  /**
   * Keep new links, in the order the engine ranked them.
   *
   * Pages overlap by a result or two, so the deduplication is not incidental:
   * eleven pages of ten come back as about ninety distinct sites.
   *
   * @param {string[]} found
   */
  const keep = (found) => {
    for (const link of found) {
      if (seen.has(link)) continue;
      seen.add(link);
      links.push(link);
    }
  };

  const first = await searchFirstPage(term, settings);
  // The first page failing means the keyword produced nothing, and the reason —
  // quota, bad key — is the caller's to act on.
  if (!first.ok) return { ok: false, keyword: term, error: first.error };

  fetched += 1;
  keep(first.links);

  // An empty first page is a keyword with no results, not a failure.
  let exhausted = first.links.length === 0;
  let next = 2;

  while (!exhausted && links.length < target && next <= maxPages) {
    const wave = [];
    for (let page = next; page < next + width && page <= maxPages; page += 1) wave.push(page);
    next += wave.length;

    // Awaited together, read in page order, so rank survives the concurrency.
    const results = await Promise.all(wave.map((page) => searchPage(term, page, settings)));

    for (const res of results) {
      if (!res.ok) continue;

      fetched += 1;
      // A page with nothing on it is the end of the results. The rest of this
      // wave is already paid for, so it is still read — only the next wave is
      // called off.
      if (res.links.length === 0) exhausted = true;
      else keep(res.links);
    }
  }

  return { ok: true, keyword: term, links: links.slice(0, target), pages: fetched };
}

// There is deliberately no searchKeywords() batch helper. Keywords are queued
// individually in the database and searched one at a time — by the request
// while its budget lasts, then by the poller — because each one has to record
// its own outcome and because a batch that runs to completion in memory is
// exactly what the queue exists to avoid.
