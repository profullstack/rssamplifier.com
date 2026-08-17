import {
  resolveFeed,
  scrapeFeed,
  normalizeUrl,
  parseOpml,
  streamOpmlOutlines,
  uniqueSlug,
} from '@rssamplifier/feed';
import { q } from '@rssamplifier/db';

import { importFeeds } from './import.js';
import { refreshFeedKeywords } from './crawl.js';

/** Cap on a single bulk submission, so one paste can't queue thousands of fetches. */
const MAX_BATCH = 200;

/**
 * How many entries of a catalogue are resolved while the submitter waits.
 *
 * Each one is an outbound fetch, so this is the request's time budget. The
 * rest is queued for the poller rather than dropped.
 */
const INLINE_LIMIT = 100;

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
  const url = normalizeUrl(input);
  if (!url) return { ok: false, url: String(input), error: 'invalid-url' };

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
    if (res.ok) accepted.push({ slug: res.slug, existing: res.existing });
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
 * @param {{ inlineLimit?: number, submissionId?: string|null, spreadMinutes?: number, onQueued?: (queued: number) => void }} [opts]
 * @returns {Promise<{ accepted: object[], rejected: object[], queued: number, total: number }>}
 */
export async function submitCatalogue(db, entries, opts = {}) {
  const inlineLimit = opts.inlineLimit ?? INLINE_LIMIT;

  const head = entries.slice(0, inlineLimit);
  const tail = entries.slice(inlineLimit);

  let queued = 0;
  if (tail.length > 0) {
    const imported = await importFeeds(db, tail, {
      submissionId: opts.submissionId ?? null,
      spreadMinutes: opts.spreadMinutes,
    });
    queued = imported.inserted;
  }

  opts.onQueued?.(queued);

  const { accepted, rejected } = await submitMany(
    db,
    head.map((e) => e.url),
  );

  return { accepted, rejected, queued, total: entries.length };
}

/**
 * Accept a catalogue that is still arriving.
 *
 * The same contract as `submitCatalogue` — resolve the head, queue the tail —
 * for a source that has no length and does not fit in memory. Nothing here
 * accumulates except the head, which is a hundred entries by definition.
 *
 * The tail is handed to `importFeeds` as a generator rather than an array, so
 * the importer pulls entries through the scanner at the rate it can write them.
 * That is what keeps the whole path flat in memory: the upload is never faster
 * than the database for long, and back-pressure travels all the way out to the
 * socket instead of piling up in the heap.
 *
 * `onQueued` therefore fires once the upload has been fully received, which is
 * later than the array version's — there is no honest way to know a stream's
 * tail is durable before the stream has ended.
 *
 * @param {import('@libsql/client').Client} db
 * @param {AsyncIterable<{ url: string, title?: string, siteUrl?: string|null }>} entries
 * @param {{ inlineLimit?: number, submissionId?: string|null, spreadMinutes?: number, onQueued?: (queued: number) => void }} [opts]
 * @returns {Promise<{ accepted: object[], rejected: object[], queued: number, total: number }>}
 */
export async function submitCatalogueStream(db, entries, opts = {}) {
  const inlineLimit = opts.inlineLimit ?? INLINE_LIMIT;

  /** @type {Array<{ url: string, title?: string, siteUrl?: string|null }>} */
  const head = [];
  let total = 0;

  async function* tail() {
    for await (const entry of entries) {
      total += 1;
      if (head.length < inlineLimit) {
        head.push(entry);
        continue;
      }
      yield entry;
    }
  }

  const imported = await importFeeds(db, tail(), {
    submissionId: opts.submissionId ?? null,
    spreadMinutes: opts.spreadMinutes,
  });

  const queued = imported.inserted;
  opts.onQueued?.(queued);

  const { accepted, rejected } = await submitMany(
    db,
    head.map((e) => e.url),
  );

  return { accepted, rejected, queued, total };
}

/**
 * Accept an OPML upload as it arrives, without ever holding the document.
 *
 * The streaming counterpart of `submitOpml`, and the one the endpoint uses for
 * a file: it scans rather than parses, so the ceiling is `opts.maxBytes` and
 * not the heap. `submitOpml` stays for callers that already have the whole
 * string in hand — the MCP tool, and a JSON body with `opml` in it — where
 * parsing properly is both affordable and better.
 *
 * @param {import('@libsql/client').Client} db
 * @param {AsyncIterable<Uint8Array|string>} chunks
 * @param {{ maxBytes?: number, inlineLimit?: number, submissionId?: string|null, spreadMinutes?: number, onQueued?: (queued: number) => void }} [opts]
 * @returns {Promise<{ accepted: object[], rejected: object[], queued: number, total: number }>}
 */
export async function submitOpmlStream(db, chunks, opts = {}) {
  const entries = streamOpmlOutlines(chunks, { maxBytes: opts.maxBytes });
  const result = await submitCatalogueStream(db, entries, opts);

  // Said in the same words the whole-document path uses, so a caller cannot
  // tell a streamed empty upload from a parsed one.
  if (result.total === 0) {
    return { ...result, rejected: [{ url: '', error: 'no-feeds-in-opml' }] };
  }

  return result;
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
