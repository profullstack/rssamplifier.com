/*
 * Looking for a person who did not leave a trail.
 *
 * Everything else in the enrichment reads something the publisher put where we
 * could find it: their feed, their page, their hostname, their profile. This
 * asks a search engine instead, which is a different kind of act and carries a
 * different kind of risk, so it is fenced in three ways that are not optional.
 *
 * **It cannot run over the directory.** Search is metered. The account this
 * borrows is CrawlProof's 25,000-credit month, already shared with CrawlProof's
 * own outreach runner, and the directory is 369,056 feeds — one query each
 * would be fifteen times the entire monthly allowance. So this is a targeted
 * tool with a hard budget, off unless switched on, and it refuses rather than
 * degrades when the budget is gone.
 *
 * **It cannot invent a person.** Searching a name and attaching what comes back
 * is how two different people with one name become one page. `identity.js` has
 * refused to key on a name alone since it was written, and this must not become
 * the back door: a search result is a *candidate*, and what promotes it is
 * corroboration — the page linking back to the site we already know is theirs,
 * or a handle we already hold from a source that proved itself.
 *
 * **It cannot be the reason we hold something.** Every link it produces is
 * stamped `web-search`, so any consumer can exclude the whole class. Nothing
 * here is ever marked `verified` on the strength of a search result.
 *
 * On LinkedIn specifically, since it is the thing everybody asks for: a profile
 * URL found this way is stored as a link, because it is a public address the
 * search engine already indexed. The profile behind it is not fetched — it is
 * auth-walled, returns 999 to anything automated, and its terms forbid
 * scraping. So we can tell you where somebody's LinkedIn is, and cannot tell
 * you what is on it.
 */

import { classifyLink } from '@rssamplifier/feed';
import { authors as a } from '@rssamplifier/db';

/** Where the searches are bought. */
const ENDPOINT = 'https://api.valueserp.com/search';

/** How long to wait for a result before abandoning it. */
const TIMEOUT_MS = 8000;

/**
 * The networks worth spending a query on, and how to ask for them.
 *
 * One query per network rather than one broad query, because a search for a
 * name alone returns news articles and namesakes, while a site-scoped one
 * returns a profile or nothing — and "nothing" is the answer we want when the
 * person genuinely has no account there.
 *
 * LinkedIn leads because it is the one this exists for. The rest are ordered by
 * how often this directory's population actually has them.
 */
const TARGETS = [
  { network: 'linkedin', site: 'linkedin.com/in' },
  { network: 'github', site: 'github.com' },
  { network: 'twitter', site: 'x.com' },
  { network: 'bluesky', site: 'bsky.app/profile' },
];

/**
 * Is a search worth buying for this person?
 *
 * The gate is deliberately mean, because the budget is small and the value of a
 * query is wildly uneven. A person who writes one dormant blog and already has
 * an email is not worth a credit; a person behind several live feeds with no
 * way to reach them at all is the whole point.
 *
 * @param {{ feedCount?: number, linkCount?: number, confidence?: number, name?: string }} author
 * @param {{ minFeeds?: number }} [opts]
 * @returns {boolean}
 */
export function worthSearching(author, opts = {}) {
  const minFeeds = Number(opts.minFeeds ?? 1);

  // Somebody we are not confident is a person should not be searched for: the
  // query would be for a name we half-believe, and the results would be
  // attached to it.
  if (Number(author?.confidence ?? 0) < 0.8) return false;

  // A name that is one word is not searchable in any useful way -- "Sakrecoer"
  // returns the person, but "Jane" returns the world.
  const words = String(author?.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;

  if (Number(author?.feedCount ?? 0) < minFeeds) return false;

  // Already reachable. The point of the budget is the people we cannot contact.
  if (Number(author?.linkCount ?? 0) > 0) return false;

  return true;
}

/**
 * The queries to buy for one person.
 *
 * Scoped to their own site as well as to each network, because the name alone
 * is the ambiguous part: "Jane Doe" site:linkedin.com/in returns every Jane
 * Doe, while the domain of the blog she writes is the thing that distinguishes
 * her from them.
 *
 * @param {{ name: string, site?: string|null }} author
 * @returns {Array<{ network: string, q: string }>}
 */
export function searchesFor(author) {
  const name = String(author?.name ?? '').trim();
  if (!name) return [];

  const domain = hostOf(author?.site);

  return TARGETS.map((target) => ({
    network: target.network,
    q: domain
      ? `"${name}" ${domain} site:${target.site}`
      : `"${name}" site:${target.site}`,
  }));
}

/**
 * Read a ValueSERP response into the links it actually contains.
 *
 * Only results whose URL classifies as the network we asked for are kept. A
 * search for a LinkedIn profile routinely returns a LinkedIn *company* page, a
 * job posting or an article about the person, none of which is an account —
 * `classifyLink` already knows the difference and is the filter.
 *
 * @param {string} network the network the query was scoped to
 * @param {unknown} body the parsed JSON
 * @returns {Array<{ network: string, url: string, handle: string, source: string, verified: boolean }>}
 */
export function linksFromSearch(network, body) {
  const results = Array.isArray(/** @type {any} */ (body)?.organic_results)
    ? /** @type {any} */ (body).organic_results
    : [];

  /** @type {Map<string, object>} */
  const found = new Map();

  for (const result of results) {
    const link = classifyLink(result?.link);
    if (!link || link.network !== network) continue;
    if (found.has(link.url)) continue;

    found.set(link.url, {
      ...link,
      source: 'web-search',
      // Never. A search engine's opinion that two strings co-occur is not the
      // IndieWeb handshake, and this column means the handshake.
      verified: false,
    });
  }

  return [...found.values()];
}

/**
 * Buy the searches for one person, within a budget.
 *
 * Returns the links and how many credits were actually spent, so the caller can
 * keep a running total that survives a restart by being written down rather
 * than held in memory.
 *
 * Every failure is empty and silent, exactly as the ad fetch is: enrichment is
 * a bonus on top of a directory, and a search provider having a bad afternoon
 * must not stop the pass that does not need it.
 *
 * @param {{ name: string, site?: string|null }} author
 * @param {{ apiKey: string, budget: number, fetch?: typeof globalThis.fetch }} opts
 *   `budget` is the number of queries this call may spend, already decided by
 *   the caller against the month's remaining allowance
 * @returns {Promise<{ links: Array<object>, spent: number, exhausted?: boolean }>}
 *   `exhausted` says the account is empty, which will not change before the
 *   provider's reset -- the caller stops rather than asking again
 */
export async function searchForAuthor(author, opts) {
  const apiKey = String(opts?.apiKey ?? '');
  const budget = Math.max(0, Math.floor(Number(opts?.budget ?? 0)));
  if (!apiKey || budget === 0) return { links: [], spent: 0 };

  const doFetch = opts.fetch ?? globalThis.fetch;
  const queries = searchesFor(author).slice(0, budget);

  /** @type {Map<string, object>} */
  const links = new Map();
  let spent = 0;

  for (const query of queries) {
    const url =
      `${ENDPOINT}?api_key=${encodeURIComponent(apiKey)}` +
      `&q=${encodeURIComponent(query.q)}&num=10&output=json`;

    let body;
    try {
      const res = await doFetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });

      // 402 is the documented answer for an exhausted account, and it is not a
      // transient error -- there is no point asking again this month, so the
      // caller is told to stop rather than left to burn the rest of the batch
      // on the same refusal.
      if (res.status === 402) return { links: [...links.values()], spent, exhausted: true };
      if (!res.ok) continue;

      body = await res.json();
    } catch {
      continue;
    }

    // Counted whether or not anything useful came back: the credit is spent at
    // the provider either way, and a budget that only counts hits is not a
    // budget.
    spent += 1;

    for (const link of linksFromSearch(query.network, body)) {
      if (!links.has(link.url)) links.set(link.url, link);
    }
  }

  return { links: [...links.values()], spent };
}

/**
 * The bare host of a URL, for scoping a query to somebody's own domain.
 *
 * @param {unknown} value
 * @returns {string}
 */
function hostOf(value) {
  try {
    return new URL(String(value ?? '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Spend part of the month's allowance on the people nobody can reach.
 *
 * The budget is read from the ledger rather than from a counter, because the
 * poller restarts on every deploy and a budget that resets with the process is
 * not a budget. `billingPeriodStart` matches the provider's own cycle -- this
 * account resets on the 13th, not the 1st -- so the total this compares against
 * is the total the invoice will show.
 *
 * Stops at the first sign the account is empty. A 402 is the documented answer
 * for an exhausted allowance and it will not change before the reset, so
 * carrying on would spend the rest of the batch's wall-clock re-reading the
 * same refusal.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{
 *   apiKey: string,
 *   monthlyBudget: number,
 *   perAuthor?: number,
 *   batchSize?: number,
 *   minConfidence?: number,
 *   fetch?: typeof globalThis.fetch,
 * }} opts
 * @returns {Promise<{ people: number, links: number, spent: number, remaining: number }>}
 */
export async function searchDue(db, opts) {
  const apiKey = String(opts?.apiKey ?? '');
  const monthly = Math.max(0, Math.floor(Number(opts?.monthlyBudget ?? 0)));
  if (!apiKey || monthly === 0) return { people: 0, links: 0, spent: 0, remaining: 0 };

  const since = a.billingPeriodStart();
  const already = await a.searchSpendSince(db, since);
  let remaining = monthly - already;
  if (remaining <= 0) return { people: 0, links: 0, spent: 0, remaining: 0 };

  const perAuthor = Math.max(1, Math.floor(Number(opts.perAuthor ?? 2)));
  const batchSize = Math.max(1, Math.floor(Number(opts.batchSize ?? 5)));

  const candidates = await a.authorsWithoutContact(
    db,
    batchSize,
    Number(opts.minConfidence ?? 0.8),
  );

  let people = 0;
  let links = 0;
  let spent = 0;

  for (const author of candidates) {
    if (remaining <= 0) break;

    // The SQL above already selects for this, and the check is repeated here on
    // purpose: the query and the rule are two statements of one policy, and the
    // cheap one is the one that must not be the only one. If they ever drift,
    // this refuses to spend money on the difference.
    if (
      !worthSearching({
        name: String(author.name ?? ''),
        confidence: Number(author.confidence ?? 0),
        feedCount: Number(author.feed_count ?? 0),
        linkCount: 0,
      })
    ) {
      continue;
    }

    const result = await searchForAuthor(
      { name: String(author.name), site: author.site },
      {
        apiKey,
        budget: Math.min(perAuthor, remaining),
        fetch: opts.fetch,
      },
    );

    // Written down before anything else, because the credits are gone whether
    // or not the rest of this succeeds, and a ledger that only records
    // successful passes will drift under the real spend.
    if (result.spent > 0) {
      await a.recordAuthorSearch(db, {
        authorId: String(author.id),
        queries: result.spent,
        found: result.links.length,
      });
    }

    spent += result.spent;
    remaining -= result.spent;

    if (result.links.length > 0) {
      links += await a.addAuthorLinks(db, String(author.id), result.links);
      people += 1;
    }

    // The account is empty. Nothing further this period will succeed.
    if (result.exhausted) break;
  }

  return { people, links, spent, remaining: Math.max(0, remaining) };
}
