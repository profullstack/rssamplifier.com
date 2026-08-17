import { normalizeUrl, parseOpml, uniqueSlug } from '@rssamplifier/feed';
import { q, nowIso } from '@rssamplifier/db';

/** Statements per libSQL batch. Large enough to amortise latency, small enough not to time out. */
const CHUNK = 500;

/** Default window over which a bulk import is spread, in minutes. */
const SPREAD_MINUTES = 240;

/**
 * Slots the spread window is divided into when the size of an import is not
 * known ahead of time.
 *
 * A streamed catalogue has no length until it ends, so the "position out of
 * total" spread cannot be computed. Dealing them round-robin into a fixed
 * number of slots gets the same property that actually matters — the poller
 * never sees the whole import come due at once — without needing the total, and
 * it degrades sensibly in both directions: a short import fills the first few
 * slots, a huge one stacks evenly across all of them.
 */
const SPREAD_SLOTS = 240;

/**
 * Import a catalogue of feeds without fetching any of them.
 *
 * This is the bulk sibling of `submitMany`. Submission resolves each URL over
 * the network first, which is right for a human pasting one link and impossible
 * for a 47,000-entry OPML: it would open that many outbound requests and take
 * days. Here the catalogue's own title and site URL are trusted, the rows land
 * as `pending`, and the poller replaces the placeholder metadata the first time
 * it crawls each feed.
 *
 * Rows are given `next_fetch_at` spread evenly across `spreadMinutes` rather
 * than all set to now. An import that makes 47k feeds due in the same instant
 * gives the crawler a backlog it can only work through in arrival order, and
 * makes the due-count useless as a health signal; spreading it turns the import
 * into a steady drip the poller can actually keep up with.
 *
 * `entries` may be an array or an async iterable. The async form is what an
 * upload streams through: the importer pulls entries as the scanner produces
 * them, so a catalogue is never assembled in memory to be handed over. The only
 * thing lost with it is the total, which is not known until the stream ends —
 * see `SPREAD_SLOTS` for what stands in.
 *
 * @param {import('@libsql/client').Client} db
 * @param {Array<{ url: string, title?: string, siteUrl?: string }>|AsyncIterable<{ url: string, title?: string, siteUrl?: string }>} entries
 * @param {{ spreadMinutes?: number, submissionId?: string|null, onProgress?: (p: { inserted: number, seen: number, total: number|null }) => void }} [opts]
 * @returns {Promise<{ inserted: number, skipped: number, invalid: number, total: number }>}
 */
export async function importFeeds(db, entries, opts = {}) {
  const spreadMinutes = opts.spreadMinutes ?? SPREAD_MINUTES;
  const submissionId = opts.submissionId ?? null;
  const onProgress = opts.onProgress;

  // null for a stream, which has no length until it has been consumed.
  const total = Array.isArray(entries) ? entries.length : null;

  // One read of the whole table beats a per-row existence check: at this size
  // the round trips, not the memory, are what make or break the import. Note
  // that this set, not the parse, is what bounds a very large import — it holds
  // one key per feed in the directory plus one per feed accepted from the
  // upload, which is inherent to deduplicating without a round trip per row.
  const { urls, slugs } = await q.existingFeedKeys(db);

  const pending = [];
  let inserted = 0;
  let skipped = 0;
  let invalid = 0;
  let queued = 0;
  let seen = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    inserted += await q.insertFeedsBulk(db, pending.splice(0, pending.length));
    onProgress?.({ inserted, seen: queued + skipped + invalid, total });
  };

  // `for await` reads an array and an async iterable alike, so the two callers
  // need no branch between them.
  for await (const entry of entries) {
    seen += 1;
    const url = normalizeUrl(entry?.url ?? '');
    if (!url) {
      invalid += 1;
      continue;
    }

    const key = url.toLowerCase();
    if (urls.has(key)) {
      skipped += 1;
      continue;
    }
    urls.add(key);

    const slug = uniqueSlug(entry.title ?? '', url, (s) => slugs.has(s));
    slugs.add(slug);

    // Spread by position in the accepted set, not in the input: skipped
    // duplicates would otherwise leave gaps in the schedule.
    const windowMs = spreadMinutes * 60_000;
    const offsetMs =
      total === null
        ? (queued % SPREAD_SLOTS) * (windowMs / SPREAD_SLOTS)
        : total > 1
          ? (queued / total) * windowMs
          : 0;

    pending.push({
      slug,
      feed_url: url,
      site_url: entry.siteUrl ?? null,
      title: entry.title?.trim() || hostnameOf(url),
      next_fetch_at: nowIso(offsetMs),
      submission_id: submissionId,
    });
    queued += 1;

    if (pending.length >= CHUNK) await flush();
  }

  await flush();

  return { inserted, skipped, invalid, total: total ?? seen };
}

/**
 * Import an OPML subscription list in bulk.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} xml
 * @param {object} [opts] forwarded to importFeeds
 * @returns {Promise<{ inserted: number, skipped: number, invalid: number, total: number }>}
 */
export async function importOpml(db, xml, opts = {}) {
  return importFeeds(db, parseOpml(xml), opts);
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
