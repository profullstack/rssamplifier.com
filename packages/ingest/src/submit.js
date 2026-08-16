import { resolveFeed, normalizeUrl, parseOpml, uniqueSlug } from '@rssamplifier/feed';
import { q } from '@rssamplifier/db';

/** Cap on a single bulk submission, so one paste can't queue thousands of fetches. */
const MAX_BATCH = 200;

/**
 * Claim a free slug, consulting the database for collisions.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} title
 * @param {string} feedUrl
 * @returns {Promise<string>}
 */
async function claimSlug(db, title, feedUrl) {
  // uniqueSlug only ever probes base, base-2, base-3 … so fetching that narrow
  // prefix is enough; no need to read the whole table.
  const base = uniqueSlug(title, feedUrl);
  const taken = await q.takenSlugs(db, base);
  return uniqueSlug(title, feedUrl, (s) => taken.has(s));
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

  const resolved = await resolveFeed(url);
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
      status: 'active',
      item_count: feed.items.length,
    });
  } catch (err) {
    // A concurrent submission of the same feed can win the unique index between
    // our lookup and our insert. That is a success, not an error.
    const raced = await q.feedByUrl(db, feedUrl);
    if (raced) return { ok: true, slug: String(raced.slug), existing: true };
    return { ok: false, url, error: String(err?.message ?? err) };
  }

  await q.upsertItems(db, inserted.id, feed.items);
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
 * Accept an OPML document.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} xml
 * @returns {Promise<{ accepted: object[], rejected: object[] }>}
 */
export async function submitOpml(db, xml) {
  const feeds = parseOpml(xml);
  if (feeds.length === 0) {
    return { accepted: [], rejected: [{ url: '', error: 'no-feeds-in-opml' }] };
  }
  return submitMany(
    db,
    feeds.map((f) => f.url),
  );
}
