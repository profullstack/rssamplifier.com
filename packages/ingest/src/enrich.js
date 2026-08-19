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
 *   accounts found on the feed's site. Always stored against the feed; also
 *   copied onto the author when there is exactly one of them.
 * @returns {Promise<{ people: number, links: number, feedLinks: number }>}
 */
export async function storeCredits(db, feed, credits, links = []) {
  const { statements, people, links: linkCount, feedLinks } = await prepareCredits(db, feed, credits, links);
  if (statements.length === 0) return { people: 0, links: 0, feedLinks: 0 };

  // One transaction for the people, the feed's link to them, their accounts and
  // the feed's own accounts. Ordered so each author row is inserted before
  // anything selects its id.
  await db.batch(statements, 'write');
  return { people, links: linkCount, feedLinks };
}

/**
 * The same work, stopping short of writing.
 *
 * Split out so `crawlFeed` can fold these statements into the single write
 * transaction that also carries the items, the feed row and the topics. On this
 * database writes serialize -- SQLite has one writer -- so a crawl costs very
 * nearly the number of transactions it opens. This used to be one of three per
 * feed; it is now part of one.
 *
 * The reads stay here because they must happen first and cannot be batched: a
 * slug has to be unique, which means looking at the ones already taken.
 *
 * @param {Client} db
 * @param {{ id: string, feed_url: string }} feed
 * @param {Array<import('@rssamplifier/feed').Credit>} credits
 * @param {Array<object>} [links]
 * @returns {Promise<{ statements: Array<{sql: string, args: unknown[]}>, people: number, links: number, feedLinks: number }>}
 */
export async function prepareCredits(db, feed, credits, links = []) {
  const merged = mergeCredits(credits.filter(Boolean));

  // Slugs first, and they are the only reads left here.
  //
  // A slug has to be unique and it is chosen by looking at the ones already
  // taken, so it cannot be decided inside the write. Everything else can:
  // `creditStatements` resolves each author's id in SQL rather than reading it
  // back, which is what collapses this whole function into one write
  // transaction. It used to be four -- and on this database a write transaction
  // costs ~370ms and they serialize, so four per feed was most of the crawler's
  // ceiling.
  //
  // Only asked for a person we do not already have. An author we know keeps the
  // slug they were given: it is a permanent address, and re-deriving it from a
  // display name that has since changed would break every link to their page.
  const prepared = [];
  for (const person of merged) {
    const key = identityKey(person, feed.feed_url);
    const existing = await a.authorByIdentity(db, key);
    prepared.push({
      key,
      person,
      slug: existing?.slug ?? (await claimAuthorSlug(db, person.name, person.url)),
    });
  }

  const statements = [];
  let authorLinkCount = 0;

  for (const [index, { key, person, slug }] of prepared.entries()) {
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
    // feed keeps only what each credit carried on its own -- and the footer's
    // accounts stay on the feed below, which is the claim that is actually
    // true of a group blog.
    if (merged.length === 1) own.push(...links);
    authorLinkCount += own.filter((l) => l?.url && l?.network).length;

    statements.push(
      ...a.creditStatements({
        feedId: feed.id,
        identityKey: key,
        slug,
        person: {
          name: person.name,
          normName: normalizeName(person.name),
          bio: person.bio ?? '',
          avatarUrl: person.avatar,
          siteUrl: person.url,
          email: person.email,
          confidence: person.confidence,
          role: person.role,
          evidence: person.source,
        },
        authorLinks: own,
        // The feed's own accounts ride along with the first person only, so a
        // feed crediting three people does not queue the same feed_links rows
        // three times. Stored whether or not anybody was named -- see below.
        feedLinks: index === 0 ? links : [],
      }),
    );
  }

  // The feed's own accounts, stored whether or not anybody was named. This is
  // the common case on the small web and it used to be thrown away: a blog
  // with a Mastodon link in its footer and no byline anywhere published a way
  // to reach whoever writes it, and an empty `merged` meant returning before
  // anything was written. On a probe of fifteen production feeds twelve had at
  // least one account and only nine named a person, so a third of what the
  // directory could find was being discarded for want of a name to file it
  // under.
  if (merged.length === 0) statements.push(...a.feedLinkStatements(feed.id, links));

  return {
    statements,
    people: merged.length,
    // Statements issued rather than rows changed. The guards on the conflict
    // clauses mean an unchanged credit writes nothing, so a row count here
    // would report a healthy re-crawl as having stored no links at all -- which
    // is true and useless. What the callers want to know is how much the
    // document offered.
    links: authorLinkCount,
    feedLinks: (links ?? []).filter((l) => l?.url && l?.network).length,
  };
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

      // The page's bio belongs to the people that page credits. It is attached
      // here rather than inside the extractor because only the caller knows
      // that these credits and this bio came off the same page -- and a bio
      // from somebody's homepage must not be pinned to a name found later on a
      // different one. Only filled where a credit has none of its own, so a
      // per-person h-card note always beats the page-level summary.
      for (const found of identity.credits) {
        if (!found.bio && identity.bio) found.bio = identity.bio;
        credits.push(found);
      }

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
 * How many publishers are enriched at once.
 *
 * Distinct publishers, never the same one twice — see `enrichDue`. Lower than
 * the crawl's pool because each unit here is several fetches rather than one,
 * so six workers already have more sockets open than the crawler's eight.
 */
export const ENRICH_CONCURRENCY_DEFAULT = 6;

/**
 * How many rows to read before choosing a batch from them, so the spread has
 * something to choose from. The crawl's reasoning exactly, at the crawl's cost:
 * one indexed read either way.
 */
const OVERREAD = 3;

/**
 * How many feeds on one host may enter a single batch.
 *
 * A host's feeds are enriched strictly in series, so a batch that is mostly one
 * host has a floor on its wall-clock no amount of concurrency can lift — and
 * this hurts here more than it does in the crawl, because one unit of work is
 * three or four fetches rather than one.
 */
const PER_HOST = 3;

/**
 * Run the enrichment pass over the feeds that are due for one.
 *
 * Concurrent across publishers, strictly serial within one — which is the same
 * guarantee this made when it ran the whole batch in series, arrived at the way
 * the crawl arrives at it.
 *
 * The original reasoning was sound and is worth keeping straight, because it is
 * only half a reason to be sequential: enriching one feed means three or four
 * fetches of the *same* host, so those must not overlap, or a directory that
 * asks people to publish `rel="me"` becomes the reason their server falls over.
 * That argument covers the pages of one site. It never covered two unrelated
 * blogs, and running those in series is what made this the slowest thing in the
 * daemon by an order of magnitude: measured in production, a batch of five took
 * minutes rather than the tick's sixty seconds, and because the poller skips a
 * tick while one is still running, the directory was being walked at roughly an
 * eighth of its configured rate — 1,536 feeds of 369,054 in two days.
 *
 * So the work is grouped into one queue per host and the queues are handed to a
 * small pool, exactly as `crawlDue` does. One host is one worker's problem from
 * start to finish, so no publisher ever sees two requests at once; unrelated
 * publishers no longer wait behind each other.
 *
 * Grouped on the host that will actually be *fetched* — the site — rather than
 * the feed's, because those differ often enough to matter: a blog on its own
 * domain with a feed proxied through a platform would otherwise be filed under
 * the platform, and every such blog would end up in one queue.
 *
 * @param {Client} db
 * @param {number} [batchSize]
 * @param {{ verify?: boolean, recheckDays?: number, onEvent?: ((event: object) => void)|null,
 *   concurrency?: number, fetch?: typeof safeFetch, resolve?: typeof resolveFeed }} [opts]
 * @returns {Promise<{ feeds: number, people: number, links: number, hosts: number }>}
 */
export async function enrichDue(db, batchSize = 10, opts = {}) {
  const recheckDays = Number(opts.recheckDays ?? 90);
  const recheckBefore = new Date(Date.now() - recheckDays * 86_400_000).toISOString();

  const pool = await a.dueForAuthors(db, batchSize * OVERREAD, recheckBefore);
  if (pool.length === 0) return { feeds: 0, people: 0, links: 0, feedLinks: 0, hosts: 0 };

  const queues = enrichQueues(pool, batchSize);

  let feeds = 0;
  let people = 0;
  let links = 0;
  let feedLinks = 0;
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= queues.length) return;

      for (const feed of queues[index]) {
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
          feedLinks += result.feedLinks ?? 0;
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
    }
  };

  const wanted =
    Number(opts.concurrency) > 0 ? Number(opts.concurrency) : ENRICH_CONCURRENCY_DEFAULT;
  const workers = Math.max(1, Math.min(wanted, queues.length));
  await Promise.all(Array.from({ length: workers }, worker));

  // `hosts` is what says whether the spread is working: a batch that is four
  // hosts cannot go faster than its biggest queue however many workers are
  // pointed at it, and the number is otherwise invisible from outside.
  return { feeds, people, links, feedLinks, hosts: queues.length };
}

/**
 * Choose a batch spread across publishers, and hand back one queue per host.
 *
 * Longest queue first, because whichever host is heaviest in this batch is the
 * one that decides when the batch ends and so must start at the beginning of
 * it.
 *
 * @param {object[]} pool candidate rows, already in due order
 * @param {number} batchSize
 * @returns {Array<Array<object>>}
 */
function enrichQueues(pool, batchSize) {
  const byHost = new Map();
  const overflow = [];

  // First pass: up to `PER_HOST` from each host, in the order they came due.
  for (const feed of pool) {
    const host = enrichHost(feed);
    const queue = byHost.get(host);

    if (!queue) byHost.set(host, [feed]);
    else if (queue.length < PER_HOST) queue.push(feed);
    else overflow.push(feed);
  }

  // Second pass, and the one that keeps a monolithic due set moving at the rate
  // it moved before: when a bulk import comes due together the whole batch is
  // legitimately one host, and throttling that to `PER_HOST` would stall it.
  let taken = [...byHost.values()].reduce((n, q) => n + q.length, 0);
  for (const feed of overflow) {
    if (taken >= batchSize) break;
    byHost.get(enrichHost(feed)).push(feed);
    taken += 1;
  }

  // Trim to the batch the caller asked for, cheapest queues last so the trim
  // takes from the tail rather than from the host that sets the wall-clock.
  const queues = [...byHost.values()].sort((x, y) => y.length - x.length);
  const out = [];
  let budget = batchSize;

  for (const queue of queues) {
    if (budget <= 0) break;
    out.push(queue.slice(0, budget));
    budget -= Math.min(queue.length, budget);
  }

  return out;
}

/**
 * The host enrichment will actually ask for: the site, or the feed's origin
 * when no site was published — which is the same fallback `enrichFeedAuthors`
 * makes, so the grouping matches the fetching.
 *
 * @param {{ site_url?: unknown, feed_url?: unknown }} feed
 * @returns {string}
 */
function enrichHost(feed) {
  for (const candidate of [feed.site_url, feed.feed_url]) {
    try {
      return new URL(String(candidate)).hostname.toLowerCase();
    } catch {
      /* try the next one */
    }
  }

  // Unparseable rows get their own bucket keyed by the raw string, so one bad
  // row is rejected individually rather than blocking a real host's queue.
  return String(feed.feed_url ?? feed.site_url ?? '');
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
