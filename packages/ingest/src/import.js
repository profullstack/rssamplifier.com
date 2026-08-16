import { normalizeUrl, parseOpml, uniqueSlug } from '@rssamplifier/feed';
import { q, nowIso } from '@rssamplifier/db';

/** Statements per libSQL batch. Large enough to amortise latency, small enough not to time out. */
const CHUNK = 500;

/** Default window over which a bulk import is spread, in minutes. */
const SPREAD_MINUTES = 240;

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
 * @param {import('@libsql/client').Client} db
 * @param {Array<{ url: string, title?: string, siteUrl?: string }>} entries
 * @param {{ spreadMinutes?: number, onProgress?: (p: { inserted: number, seen: number, total: number }) => void }} [opts]
 * @returns {Promise<{ inserted: number, skipped: number, invalid: number, total: number }>}
 */
export async function importFeeds(db, entries, opts = {}) {
  const spreadMinutes = opts.spreadMinutes ?? SPREAD_MINUTES;
  const onProgress = opts.onProgress;

  // One read of the whole table beats a per-row existence check: at this size
  // the round trips, not the memory, are what make or break the import.
  const { urls, slugs } = await q.existingFeedKeys(db);

  const pending = [];
  let inserted = 0;
  let skipped = 0;
  let invalid = 0;
  let queued = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    inserted += await q.insertFeedsBulk(db, pending.splice(0, pending.length));
    onProgress?.({ inserted, seen: queued + skipped + invalid, total: entries.length });
  };

  for (const entry of entries) {
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
    const offsetMs = entries.length > 1 ? (queued / entries.length) * spreadMinutes * 60_000 : 0;

    pending.push({
      slug,
      feed_url: url,
      site_url: entry.siteUrl ?? null,
      title: entry.title?.trim() || hostnameOf(url),
      next_fetch_at: nowIso(offsetMs),
    });
    queued += 1;

    if (pending.length >= CHUNK) await flush();
  }

  await flush();

  return { inserted, skipped, invalid, total: entries.length };
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
