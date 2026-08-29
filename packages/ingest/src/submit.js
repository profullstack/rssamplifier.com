import { resolveFeed, scrapeFeed, normalizeUrl, parseOpml, uniqueSlug } from '@rssamplifier/feed';
import { q, social } from '@rssamplifier/db';
import { socialSourceFrom } from '@rssamplifier/social';

import { queueFeeds } from './queue.js';
import { refreshFeedKeywords } from './crawl.js';

/** Cap on a single bulk submission, so one paste can't queue thousands of fetches. */
const MAX_BATCH = 200;

/**
 * How many entries of a catalogue are resolved while the submitter waits.
 *
 * One, and only when the whole submission is that one entry — see the default
 * in `submitCatalogue` for why the two conditions are not the same thing.
 *
 * This was a hundred, which read as a generous allowance and was in fact the
 * reason the submit page felt broken. Every one of those hundred is an outbound
 * resolve — up to eleven sequential candidate fetches at a fifteen-second
 * timeout, then the feed insert, the items and the topics — and the route only
 * answers early when something was *queued*, which below a hundred entries
 * nothing ever was. Measured against production: eight URLs that were already
 * in the directory took **65 seconds** and inserted nothing at all.
 *
 * So a list is queued now rather than crawled, and the queue is what the
 * submitter is sent to watch. The single URL keeps its inline resolve because
 * that is what redirects the submitter to the blog they just added, which is
 * the nicest thing that happens on the page and costs one fetch.
 */
const INLINE_LIMIT = 1;

/**
 * Submissions at or below this many entries are crawled ahead of the backlog.
 *
 * The cut-in-line lane. Queueing a submission instantly is only half an answer
 * if the queue never reaches it, and it did not: `dueFeeds` orders by
 * `next_fetch_at asc`, a new feed is stamped `now`, and there are ~307,000
 * feeds from the bulk uploads whose next_fetch_at was already in the past. A
 * blog somebody submitted today sorted behind every one of them.
 *
 * A hundred is the line between a person and an export. Nobody types more than
 * that, and every catalogue is far larger — so this expedites submissions made
 * by hand without letting an upload buy its way past the queue it belongs in.
 * `expressFeeds` bounds the other end: the lane can never take more than half a
 * tick, and a feed leaves it after one crawl attempt.
 */
export const EXPRESS_MAX = 100;

/**
 * Claim a free slug, consulting the database for collisions.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} title
 * @param {string} feedUrl
 * @returns {Promise<string>}
 */
export async function claimSlug(db, title, feedUrl) {
  // parseFeed substitutes '(untitled)' for a missing title, which would
  // slugify to a perfectly valid "untitled" and defeat uniqueSlug's hostname
  // fallback — every untitled feed would land on untitled, untitled-2, …
  // Blanking it here routes them to their own domain name instead.
  const usable = title === '(untitled)' ? '' : title;

  // uniqueSlug only ever probes base, base-2, base-3 … so fetching that narrow
  // prefix is enough; no need to read the whole table.
  const base = uniqueSlug(usable, feedUrl);
  const taken = await q.takenSlugs(db, base);
  return uniqueSlug(usable, feedUrl, (s) => taken.has(s));
}

/**
 * Accept one submitted URL: resolve it to a feed, store the feed and its items.
 *
 * Idempotent by feed_url — resubmitting a known blog returns the existing entry
 * rather than an error, because people paste the same thing twice and that is
 * not a failure.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} input
 * @returns {Promise<{ ok: true, slug: string, existing: boolean } | { ok: false, url: string, error: string }>}
 */
export async function submitOne(db, input) {
  // Asked first, before the URL is even normalised, and that order is the whole
  // difference between `/r/programming` and a subreddit filed among the blogs.
  //
  // Reddit publishes real RSS, so `https://www.reddit.com/r/programming/`
  // resolves perfectly well down the ordinary path and lands as an untyped row
  // at a slug of its own — which is exactly how 50,099 of them got here. X
  // resolves to nothing at all, so without this it is simply not submittable.
  // Recognising both up here means one answer to "what is this?" rather than a
  // special case in each caller.
  const source = socialSourceFrom(input);
  if (source) return submitSocial(db, source);

  const url = normalizeUrl(input);
  if (!url) return { ok: false, url: String(input), error: 'invalid-url' };

  // Asked before anything is fetched, because most of what people submit is
  // already here. The lookup below is the same question asked of the *resolved*
  // feed URL, which is the only form that catches "myblog.com" for a blog
  // stored as "myblog.com/feed.xml" — but it cannot be reached without paying
  // for the resolve first, and a resolve is up to eleven sequential requests at
  // a fifteen-second timeout. Eight already-indexed feeds cost 65 seconds in
  // production for exactly this reason, and every one of those fetches was of
  // a document the directory already had.
  //
  // Someone pasting a feed URL they got from this site is the common case, and
  // it is settled here for one ~90ms indexed read.
  const alreadyKnown = await q.feedByUrl(db, url);
  if (alreadyKnown) return { ok: true, slug: String(alreadyKnown.slug), existing: true };

  // A site that publishes no feed used to end here, which quietly put most of
  // the web permanently outside the directory. Now the page itself is read: if
  // it turns out to be a list of posts, the directory builds the feed the site
  // never did. Only attempted once every real feed path has been ruled out, so
  // a site that does publish is always indexed from its own document.
  let resolved = await resolveFeed(url);
  const built = !resolved.ok && resolved.error === 'no-feed-found';
  if (built) resolved = await scrapeFeed(url);

  if (!resolved.ok) return { ok: false, url, error: resolved.error };

  const { feedUrl, feed } = resolved;

  const existing = await q.feedByUrl(db, feedUrl);
  if (existing) return { ok: true, slug: String(existing.slug), existing: true };

  const slug = await claimSlug(db, feed.title, feedUrl);

  let inserted;
  try {
    inserted = await q.insertFeed(db, {
      slug,
      feed_url: feedUrl,
      site_url: feed.siteUrl,
      title: feed.title,
      description: feed.description,
      language: feed.language,
      image_url: feed.imageUrl,
      // Read off the document, not asked of the submitter: anyone can add a
      // feed here, so a category the submitter chose is a category anybody can
      // claim.
      kind: feed.kind,
      status: 'active',
      item_count: feed.items.length,
      source_kind: built ? 'scraped' : 'feed',
    });
  } catch (err) {
    // A concurrent submission of the same feed can win the unique index between
    // our lookup and our insert. That is a success, not an error.
    const raced = await q.feedByUrl(db, feedUrl);
    if (raced) return { ok: true, slug: String(raced.slug), existing: true };
    return { ok: false, url, error: String(err?.message ?? err) };
  }

  await q.upsertItems(db, inserted.id, feed.items);

  // Extracted here as well as in the crawler so a blog added by hand has topics
  // on the page the submitter is redirected to, rather than an hour later. A
  // failure is not worth losing the submission over — the next crawl of a feed
  // with no topics extracts them again.
  try {
    await refreshFeedKeywords(db, inserted.id, feed);
  } catch {
    // Deliberately silent: the blog is in the directory, which is what the
    // submitter asked for.
  }

  return { ok: true, slug: inserted.slug, existing: false };
}

/**
 * Accept a social source: claim its identity, queue its first collection.
 *
 * Nothing is fetched here, unlike `submitOne`'s ordinary path, and that is
 * deliberate on a public endpoint that anybody may call. §37 is about exactly
 * this: feed creation is the cheapest way to make somebody else's server do
 * work, and an X source in particular would make it *our* upstream and *our*
 * session paying for it. So a submission writes one row and leaves; the poller
 * collects on its next tick, expedited by `priority` into the express lane, and
 * the submitter lands on a page that fills in within the minute.
 *
 * Idempotent by canonical ref rather than by URL, which is the stronger claim:
 * `@OpenAI`, `x.com/OpenAI` and `https://twitter.com/openai/` are one source
 * here where they would be three feed rows anywhere else.
 *
 * @param {import('@libsql/client').Client} db
 * @param {ReturnType<typeof socialSourceFrom>} source
 * @returns {Promise<{ ok: true, slug: string, existing: boolean } | { ok: false, url: string, error: string }>}
 */
async function submitSocial(db, source) {
  const existing = await social.feedBySocialRef(db, source.ref);
  if (existing) return { ok: true, slug: String(existing.slug), existing: true };

  // The canonical slug first, then the collision-avoiding one. `r-programming`
  // is a better name than `programming-2` for a row whose public address is
  // /r/programming, and it is only unavailable if something already holds it.
  const taken = await q.takenSlugs(db, source.slug);
  const slug = taken.has(source.slug)
    ? uniqueSlug(source.slug, source.feedUrl, (candidate) => taken.has(candidate))
    : source.slug;

  const stored = await social.upsertSocialSource(db, {
    network: source.network,
    ref: source.ref,
    slug,
    title: source.title,
    feedUrl: source.feedUrl,
    siteUrl: source.siteUrl,
    priority: 1,
  });

  if (!stored.id) {
    // The ref was free and the slug was not, or another request took both
    // between the two statements above. Either way there is a row now.
    const raced = await social.feedBySocialRef(db, source.ref);
    return raced
      ? { ok: true, slug: String(raced.slug), existing: true }
      : { ok: false, url: source.feedUrl, error: 'slug-taken' };
  }

  return { ok: true, slug: stored.slug, existing: !stored.created, path: source.path };
}

/**
 * Accept a list of URLs.
 *
 * Sequential on purpose: each entry triggers outbound HTTP, and a hundred
 * parallel fetches from a single paste is indistinguishable from an attack on
 * the submitted hosts.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string[]} urls
 * @returns {Promise<{ accepted: Array<{slug: string, existing: boolean}>, rejected: Array<{url: string, error: string}> }>}
 */
export async function submitMany(db, urls) {
  const accepted = [];
  const rejected = [];

  for (const url of urls.slice(0, MAX_BATCH)) {
    const res = await submitOne(db, url);
    // `path` travels with the slug so a caller can redirect to the address a
    // source actually lives at. For an ordinary feed that is `/{slug}` and the
    // field is absent; for a social source it is `/r/programming` or
    // `/x/OpenAI`, and sending somebody to the slug instead would land them on
    // the same page at the address the namespace exists to replace.
    if (res.ok) accepted.push({ slug: res.slug, existing: res.existing, path: res.path ?? null });
    else rejected.push({ url: res.url, error: res.error });
  }

  return { accepted, rejected };
}

/**
 * Accept a catalogue of any size: resolve the head of it, queue the tail.
 *
 * A submission used to be capped at MAX_BATCH and everything past it was
 * dropped without a word — uploading a 47,000-feed OPML added a couple of
 * hundred blogs and silently discarded the rest. Resolving all of them inline
 * is not the fix either: that is 47,000 outbound requests held open by one HTTP
 * request.
 *
 * So the first `inlineLimit` are fetched while the submitter waits, which is
 * what makes the response feel like something happened, and the remainder is
 * written straight to the queue for the poller to crawl. The submitter gets a
 * status URL instead of a spinner.
 *
 * The tail is queued before the head is fetched, which is the opposite of the
 * obvious order and matters twice. Writing the queue is one bulk insert and
 * fetching the head is up to a hundred sequential requests, so doing the cheap
 * durable half first means a request that times out has still recorded the
 * upload instead of losing every entry past the hundredth. It is also what lets
 * a caller answer early: by the time `onQueued` fires there is a real queue to
 * show, and the fetching left to do is exactly the part worth watching.
 *
 * @param {import('@libsql/client').Client} db
 * @param {Array<{ url: string, title?: string, siteUrl?: string|null }>} entries
 * @param {{ inlineLimit?: number, submissionId?: string|null, priority?: number, onQueued?: (queued: number) => void }} [opts]
 * @returns {Promise<{ accepted: object[], rejected: object[], queued: number, total: number }>}
 */
export async function submitCatalogue(db, entries, opts = {}) {
  // A lone URL is resolved while the submitter waits, so that it can redirect
  // to the blog it added. Anything longer is a list, and a list is queued.
  //
  // Deliberately not `min(entries.length, INLINE_LIMIT)`: that would resolve the
  // first entry of a fifty-URL paste too, and the submitter is going to the
  // status page either way, so the fetch would buy them nothing but a wait.
  const inlineLimit = opts.inlineLimit ?? (entries.length === 1 ? INLINE_LIMIT : 0);

  const head = entries.slice(0, inlineLimit);
  const tail = entries.slice(inlineLimit);

  let queued = 0;
  if (tail.length > 0) {
    // `queueFeeds`, not `importFeeds`. The difference is the opening read:
    // `importFeeds` reads every feed_url and slug in the directory first, which
    // is right for one process holding one whole file and catastrophic here.
    // It pages the feeds table with `limit 5000 offset ?`, and offset paging is
    // O(offset) — measured against production at 416,000 feeds it was **still
    // running after 550 seconds**, inside a route capped at 300. Every paste of
    // 101 to 2,000 URLs therefore timed out and queued nothing. `queueFeeds`
    // asks only about the URLs in front of it.
    const imported = await queueFeeds(db, tail, {
      submissionId: opts.submissionId ?? null,
      priority: opts.priority,
    });
    queued = imported.queued;
  }

  opts.onQueued?.(queued);

  const { accepted, rejected } = await submitMany(
    db,
    head.map((e) => e.url),
  );

  return { accepted, rejected, queued, total: entries.length };
}

/**
 * Accept an OPML document of any size.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} xml
 * @param {object} [opts] forwarded to submitCatalogue
 * @returns {Promise<{ accepted: object[], rejected: object[], queued: number, total: number }>}
 */
export async function submitOpml(db, xml, opts = {}) {
  const feeds = parseOpml(xml);
  if (feeds.length === 0) {
    return {
      accepted: [],
      rejected: [{ url: '', error: 'no-feeds-in-opml' }],
      queued: 0,
      total: 0,
    };
  }
  return submitCatalogue(db, feeds, opts);
}
