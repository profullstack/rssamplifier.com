import { normalizeUrl, uniqueSlug } from '@rssamplifier/feed';
import { q, nowIso } from '@rssamplifier/db';

/** Rows written per libSQL batch. Matches importFeeds — same server, same limits. */
const CHUNK = 500;

/**
 * Feeds a catalogue is scheduled to be crawled at, per minute.
 *
 * A bulk import used to spread itself across a fixed four-hour window whatever
 * its size, which is fine for a few thousand rows and meaningless for several
 * hundred thousand: everything lands due within the same afternoon, the crawler
 * works through it in arrival order regardless, and the due-count stops being a
 * health signal because it never falls. Scheduling by rate instead of by window
 * makes the queue describe something real — how fast the poller can actually
 * take them — so a large import reads as a long drip rather than a permanent
 * backlog.
 *
 * Set just under what the crawler drains: POLL_BATCH_SIZE feeds every
 * POLL_INTERVAL_SECONDS, which in production is 300 a minute. Scheduling
 * arrivals slightly below the drain rate is what keeps the due-count falling
 * rather than flat, and it is the number to change if either of those does.
 */
const DEFAULT_RATE = 240;

/**
 * Queue one batch of a catalogue, checking only the keys this batch needs.
 *
 * The bulk sibling of {@link importFeeds}, for uploads that arrive in pieces.
 *
 * `importFeeds` opens by reading every feed_url and slug in the directory. That
 * is the right trade when one process holds one whole file: the read is paid
 * once and amortised over every row. It is the wrong trade when the same file
 * arrives as four hundred separate HTTP requests, because the cost is then paid
 * four hundred times and scales with the directory rather than with the upload
 * — importing a 700,000-entry catalogue would read 47,000 rows per batch before
 * writing anything.
 *
 * So this asks only about the keys in front of it: one indexed lookup for the
 * URLs, one for the candidate slugs, and a narrow prefix scan for the few that
 * actually collide. The result is a batch whose cost depends on the batch.
 *
 * Slugs are worth the second lookup rather than left to the unique index.
 * `insertFeedsBulk` says `on conflict do nothing`, which cannot tell a feed
 * already in the directory from a different feed whose title happened to
 * slugify the same way — so without this, two blogs called "Notes" in the same
 * upload would silently become one.
 *
 * @param {import('@libsql/client').Client} db
 * @param {Array<{ url: string, title?: string, siteUrl?: string|null }>} entries
 * @param {{
 *   submissionId?: string|null,
 *   offsetMinutes?: number,
 *   ratePerMinute?: number,
 * }} [opts]
 * @returns {Promise<{ queued: number, skipped: number, invalid: number, total: number }>}
 */
export async function queueFeeds(db, entries, opts = {}) {
  const submissionId = opts.submissionId ?? null;
  const rate = Math.max(1, opts.ratePerMinute ?? DEFAULT_RATE);
  const offsetMs = Math.max(0, opts.offsetMinutes ?? 0) * 60_000;

  // Deduplicated here as well as in the database, because two identical URLs in
  // the same batch would otherwise both be "not yet known" and the second would
  // be dropped by the unique index without being counted as the duplicate it is.
  const candidates = [];
  const seen = new Set();
  let invalid = 0;
  let repeated = 0;

  for (const entry of entries) {
    const url = normalizeUrl(entry?.url ?? '');
    if (!url) {
      invalid += 1;
      continue;
    }
    // Counted as skipped rather than passed over in silence: it is the same
    // outcome as a feed the directory already held, and a batch whose numbers
    // do not add up to what was sent reads as feeds having gone missing.
    if (seen.has(url)) {
      repeated += 1;
      continue;
    }
    seen.add(url);

    candidates.push({
      url,
      title: typeof entry?.title === 'string' ? entry.title.trim() : '',
      siteUrl: typeof entry?.siteUrl === 'string' && entry.siteUrl.trim() ? entry.siteUrl : null,
    });
  }

  const known = await q.knownFeedUrls(
    db,
    candidates.map((c) => c.url),
  );
  const fresh = candidates.filter((c) => !known.has(c.url));
  const skipped = candidates.length - fresh.length + repeated;

  if (fresh.length === 0) {
    return { queued: 0, skipped, invalid, total: entries.length };
  }

  const slugs = await claimSlugs(db, fresh);

  const rows = fresh.map((entry, i) => ({
    slug: slugs[i],
    feed_url: entry.url,
    site_url: entry.siteUrl,
    title: entry.title || hostnameOf(entry.url),
    // Spread within the batch and offset by everything queued before it, so a
    // catalogue uploaded in four hundred pieces still schedules as one steady
    // line rather than four hundred overlapping four-hour bursts.
    next_fetch_at: nowIso(offsetMs + (i / rate) * 60_000),
    submission_id: submissionId,
  }));

  let queued = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    queued += await q.insertFeedsBulk(db, rows.slice(i, i + CHUNK));
  }

  return { queued, skipped, invalid, total: entries.length };
}

/**
 * A free slug for every entry, in the same order.
 *
 * Two lookups rather than one per entry. The first asks which of the obvious
 * slugs are taken — the common answer being "none of them", which settles the
 * whole batch in a single round trip. Only the leftovers, the handful that
 * genuinely collide, are worth a `-2, -3, …` probe each.
 *
 * `taken` is grown as it goes so that collisions *within* the batch are
 * resolved too: an OPML with three feeds called "Weeknotes" gets weeknotes,
 * weeknotes-2 and weeknotes-3 rather than one row and two silent losses.
 *
 * @param {import('@libsql/client').Client} db
 * @param {Array<{ url: string, title: string }>} entries
 * @returns {Promise<string[]>}
 */
async function claimSlugs(db, entries) {
  const bases = entries.map((entry) => uniqueSlug(entry.title, entry.url));
  const taken = await q.knownSlugs(db, [...new Set(bases)]);

  // Bases already widened. Without this the widening query fires once per
  // *entry* rather than once per base, and a batch of two thousand feeds that
  // share a title — which is what a real subscription list looks like, and what
  // every untitled feed on one host becomes — costs two thousand sequential
  // round trips instead of one. Locally that is invisible; against Turso it is
  // about eighty seconds per batch, and for a file under one batch it is the
  // whole import, spent with the bar sitting at 100%.
  const widened = new Set();

  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    let slug = bases[i];

    if (taken.has(slug)) {
      if (!widened.has(bases[i])) {
        widened.add(bases[i]);
        for (const s of await q.takenSlugs(db, bases[i])) taken.add(s);
      }
      slug = uniqueSlug(entries[i].title, entries[i].url, (s) => taken.has(s));
    }

    taken.add(slug);
    out.push(slug);
  }

  return out;
}

/**
 * Hostname of a URL, for use as a placeholder title.
 *
 * @param {string} url
 * @returns {string}
 */
function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
