import {
  BIO_HOSTS,
  identityFromHtml,
  identityKey,
  linksBackTo,
  linksFromBioPage,
  mergeCredits,
  normalizeIdentityUrl,
  normalizeName,
  resolveFeed,
  safeFetch,
  uniqueSlug,
} from '@rssamplifier/feed';
import { authors as a } from '@rssamplifier/db';

/**
 * Finding the people behind the feeds, and storing where to reach them.
 *
 * Split from the crawl on purpose, in two halves that run at different rates:
 *
 * - **Free, every crawl.** A feed document already in hand names its author in
 *   `managingEditor`, `itunes:owner`, an Atom `<author>` or the item bylines.
 *   Reading it costs nothing, so `storeCredits` runs inside `crawlFeed` and
 *   the directory learns names at crawl speed.
 * - **Paid, on a slow loop.** The links — homepage, Mastodon, GitHub, the
 *   Linktree — are in the site's HTML, which a crawl never fetches. That is
 *   two to four extra requests per feed, so it gets its own pass over the
 *   directory rather than an extra request on every hourly crawl.
 *
 * The second half is what makes this worth doing. A name is a fact about a
 * blog; a name with a Mastodon account and a homepage is a person you can
 * actually talk to.
 *
 * @typedef {import('@libsql/client').Client} Client
 */

/** Pages tried on a site, in order, until one names somebody. */
const IDENTITY_PATHS = ['/', '/about', '/about/', '/about-me', '/contact', '/colophon'];

/** Cap on the pages fetched per feed, whatever the list above allows. */
const MAX_PAGES = 3;

/** Cap on bio pages followed per feed. One person, one Linktree. */
const MAX_BIO_PAGES = 1;

/** Cap on rel="me" backlinks verified per author, since each is a fetch. */
const MAX_VERIFY = 3;

/**
 * Networks whose profile pages publish a rel="me" link back to the author's
 * own site, which is the only cheap proof an account really is theirs.
 *
 * Bluesky and LinkedIn are absent because their profiles render client-side
 * and a fetch returns an app shell, so a check would always fail and the
 * absence of a backlink would read as a disproof.
 */
const VERIFIABLE = new Set(['fediverse', 'github', 'gitlab', 'codeberg', 'keybase', 'medium']);

/**
 * Claim a free slug for an author.
 *
 * @param {Client} db
 * @param {string} name
 * @param {string} fallbackUrl
 * @returns {Promise<string>}
 */
export async function claimAuthorSlug(db, name, fallbackUrl = '') {
  const base = uniqueSlug(name, fallbackUrl);
  const taken = await a.takenAuthorSlugs(db, base);
  return uniqueSlug(name, fallbackUrl, (s) => taken.has(s));
}

/**
 * Store a set of credits against a feed, creating or updating the people.
 *
 * Idempotent: the same credits stored twice update one row each rather than
 * creating a second copy, which is what lets both the crawl and the slow pass
 * call it without coordinating.
 *
 * @param {Client} db
 * @param {{ id: string, feed_url: string }} feed
 * @param {Array<import('@rssamplifier/feed').Credit>} credits
 * @param {Array<{ network: string, url: string, handle?: string, source: string, verified?: boolean }>} [links]
 *   links to attach to the single credited author, ignored when there are several
 * @returns {Promise<{ people: number, links: number }>}
 */
export async function storeCredits(db, feed, credits, links = []) {
  const merged = mergeCredits(credits.filter(Boolean));
  if (merged.length === 0) return { people: 0, links: 0 };

  let people = 0;
  let stored = 0;

  for (const person of merged) {
    const key = identityKey(person, feed.feed_url);
    const existing = await a.authorByIdentity(db, key);
    const slug = existing?.slug ?? (await claimAuthorSlug(db, person.name, person.url));

    const { id } = await a.upsertAuthor(db, {
      identityKey: key,
      slug,
      name: person.name,
      normName: normalizeName(person.name),
      bio: person.bio ?? '',
      avatarUrl: person.avatar,
      siteUrl: person.url,
      email: person.email,
      confidence: person.confidence,
    });

    await a.linkFeedAuthor(db, feed.id, id, {
      role: person.role,
      confidence: person.confidence,
      evidence: person.source,
    });

    const own = [];
    // A personal address published by the author is a link like any other, and
    // storing it here is what makes "how do I reach this person" one query.
    if (person.email) {
      own.push({
        network: 'email',
        url: `mailto:${person.email}`,
        handle: person.email,
        source: person.source.split(',')[0],
      });
    }
    if (person.url) {
      own.push({ network: 'website', url: person.url, handle: '', source: person.source.split(',')[0] });
    }

    // Links found on a page belong to *a* person, and a page crediting three
    // people does not say which. Attributing a footer's Mastodon account to
    // all three would be wrong twice out of three times, so a multi-author
    // feed keeps only what each credit carried on its own.
    if (merged.length === 1) own.push(...links);

    stored += await a.addAuthorLinks(db, id, own);
    people += 1;
  }

  return { people, links: stored };
}

/**
 * Look one feed's site over for its author and their links.
 *
 * Requests are spent in descending order of expected value: the feed document
 * first because it is one request and often names the author outright, then
 * the site's homepage, then an /about page only when the homepage said
 * nothing, then a Linktree only when one was found. A feed whose homepage
 * carries an h-card costs two requests; one that hides everything costs five
 * and is stamped as checked either way.
 *
 * @param {Client} db
 * @param {{ id: string, slug?: string, feed_url: string, site_url?: string|null, title?: string }} feed
 * @param {{ verify?: boolean, fetch?: typeof safeFetch, resolve?: typeof resolveFeed }} [opts]
 *   `fetch` and `resolve` are injected by the tests so the pass can be
 *   exercised end to end without a network
 * @returns {Promise<{ people: number, links: number, pages: number, verified: number }>}
 */
export async function enrichFeedAuthors(db, feed, opts = {}) {
  const fetchPage = opts.fetch ?? safeFetch;
  const resolve = opts.resolve ?? resolveFeed;
  const credits = [];
  /** @type {Map<string, { network: string, url: string, handle?: string, source: string, verified?: boolean }>} */
  const links = new Map();
  let pages = 0;
  let verified = 0;

  const collect = (found) => {
    for (const link of found) {
      const existing = links.get(link.url);
      if (!existing || (existing.source !== 'rel-me' && link.source === 'rel-me')) {
        links.set(link.url, { ...link, ...(existing ?? {}), source: link.source });
      }
    }
  };

  // 1. The feed document. Re-resolved rather than taken from the last crawl
  // because nothing stores the raw document, and one request is cheap next to
  // the page fetches below.
  const resolved = await resolve(String(feed.feed_url)).catch(() => null);
  if (resolved?.ok) {
    credits.push(...(resolved.feed.credits ?? []));
    // A feed that declares its site is a better base for relative links than
    // whatever the row was stored with.
    feed = { ...feed, site_url: feed.site_url || resolved.feed.siteUrl };
  }

  // 2. The site itself.
  const siteUrl = normalizeIdentityUrl(feed.site_url ?? '') || originOf(feed.feed_url);

  if (siteUrl) {
    for (const path of IDENTITY_PATHS) {
      if (pages >= MAX_PAGES) break;

      let target;
      try {
        target = new URL(path, siteUrl).toString();
      } catch {
        continue;
      }

      const page = await fetchPage(target).catch(() => null);
      if (!page?.ok || !/html/i.test(page.contentType)) continue;
      pages += 1;

      const identity = identityFromHtml(page.body, page.url || target);
      collect(identity.profiles);
      credits.push(...identity.credits);

      // The homepage named somebody and linked them somewhere: that is the
      // whole answer, and the /about page would only repeat it.
      if (identity.credits.length > 0 && identity.profiles.length > 0) break;
    }
  }

  // 3. One hop through a links page, which is the only kind of page where
  // every outbound link is known to belong to the same person.
  let hops = 0;
  for (const link of [...links.values()]) {
    if (hops >= MAX_BIO_PAGES) break;
    if (link.network !== 'linktree') continue;
    try {
      if (!BIO_HOSTS.has(new URL(link.url).hostname)) continue;
    } catch {
      continue;
    }

    const page = await fetchPage(link.url).catch(() => null);
    hops += 1;
    if (!page?.ok) continue;
    pages += 1;
    collect(linksFromBioPage(page.body, page.url || link.url));
  }

  const merged = mergeCredits(credits.filter(Boolean));

  // 4. The IndieWeb handshake, for the accounts that answer it. Only worth
  // spending requests on when there is a site to link back to, and only when
  // the caller asked — the pass over 52,000 feeds does not, a re-check of one
  // feed does.
  if (opts.verify && merged.length === 1 && siteUrl) {
    let checked = 0;
    for (const link of links.values()) {
      if (checked >= MAX_VERIFY) break;
      if (!VERIFIABLE.has(link.network)) continue;
      checked += 1;

      const page = await fetchPage(link.url).catch(() => null);
      if (!page?.ok) continue;
      pages += 1;
      if (linksBackTo(page.body, siteUrl)) {
        link.verified = true;
        verified += 1;
      }
    }
  }

  const stored = await storeCredits(db, feed, merged, [...links.values()]);
  await a.markAuthorsChecked(db, String(feed.id));

  return { ...stored, pages, verified };
}

/**
 * Run the enrichment pass over the feeds that are due for one.
 *
 * Sequential, unlike the crawl. The crawl parallelises by host because it is
 * fetching thousands of distinct domains and the throughput matters; this
 * fetches three or four pages from the *same* host per feed, so running feeds
 * concurrently would mean hitting one person's blog four times at once. A
 * directory that wants people to publish `rel="me"` links should not be the
 * reason their server falls over.
 *
 * @param {Client} db
 * @param {number} [batchSize]
 * @param {{ verify?: boolean, recheckDays?: number, onEvent?: ((event: object) => void)|null,
 *   fetch?: typeof safeFetch, resolve?: typeof resolveFeed }} [opts]
 * @returns {Promise<{ feeds: number, people: number, links: number }>}
 */
export async function enrichDue(db, batchSize = 10, opts = {}) {
  const recheckDays = Number(opts.recheckDays ?? 90);
  const recheckBefore = new Date(Date.now() - recheckDays * 86_400_000).toISOString();

  const due = await a.dueForAuthors(db, batchSize, recheckBefore);
  if (due.length === 0) return { feeds: 0, people: 0, links: 0 };

  let feeds = 0;
  let people = 0;
  let links = 0;

  for (const feed of due) {
    const started = Date.now();

    // One site that throws must not cost the batch the feeds behind it, and
    // must not leave the feed unstamped — an unstamped feed is picked up
    // first next tick, so a permanently broken one would block the queue.
    try {
      const result = await enrichFeedAuthors(db, feed, {
        verify: opts.verify,
        fetch: opts.fetch,
        resolve: opts.resolve,
      });
      feeds += 1;
      people += result.people;
      links += result.links;
      report(opts.onEvent, feed, started, { ok: true, amount: result.people, detail: null });
    } catch (err) {
      await a.markAuthorsChecked(db, String(feed.id)).catch(() => {});
      report(opts.onEvent, feed, started, {
        ok: false,
        amount: null,
        detail: String(err?.message ?? err),
      });
    }
  }

  return { feeds, people, links };
}

/**
 * The origin of a feed URL, as a last resort when no site link was published.
 *
 * @param {unknown} feedUrl
 * @returns {string}
 */
function originOf(feedUrl) {
  try {
    return new URL(String(feedUrl)).origin;
  } catch {
    return '';
  }
}

/**
 * @param {((event: object) => void)|null|undefined} onEvent
 * @param {{ feed_url: string, slug?: unknown, title?: unknown }} feed
 * @param {number} started
 * @param {{ ok: boolean, amount: number|null, detail: string|null }} outcome
 */
function report(onEvent, feed, started, outcome) {
  if (typeof onEvent !== 'function') return;

  try {
    onEvent({
      at: new Date().toISOString(),
      event: 'author',
      status: outcome.ok ? 'ok' : 'error',
      subject: String(feed.title || feed.feed_url),
      slug: feed.slug == null ? null : String(feed.slug),
      amount: outcome.amount,
      detail: outcome.detail,
      ms: Date.now() - started,
    });
  } catch {
    // A broken listener loses its line and nothing else.
  }
}
