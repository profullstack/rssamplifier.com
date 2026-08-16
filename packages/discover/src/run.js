import { discovery, q } from '@rssamplifier/db';

import { dueSources, sourceById } from './sources.js';

/**
 * Read a source and queue what it found.
 *
 * The work this does is deliberately small: fetch a list, drop what the
 * directory already has, and write the rest into the same candidate queue
 * keyword discovery fills. Resolving a candidate into a feed is the poller's
 * job and is already written — reimplementing it here would be a second place
 * for "is this feed worth a page" to be answered differently.
 *
 * Hosts already in the directory are dropped before anything is queued, for
 * the same reason the keyword path drops them: re-fetching a blog we have had
 * for a year is the most wasteful thing discovery can do, and a curated list
 * is mostly feeds we already have.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} sourceId
 * @param {{ fetchImpl?: typeof fetch, limit?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ source: string, runId: string|null, found: number, queued: number, error: string|null }>}
 */
export async function runSource(db, sourceId, opts = {}) {
  const source = sourceById(sourceId);
  if (!source) return { source: sourceId, runId: null, found: 0, queued: 0, error: 'unknown-source' };

  let urls;
  try {
    urls = await source.run({ ...opts, limit: opts.limit ?? source.limit });
  } catch (err) {
    // A source that is down is not a failure of the directory. Recorded as a
    // failed run so it is visible, and tried again on the next schedule.
    const runId = await discovery.insertRun(db, {
      provider: source.id,
      category: source.category,
      curated: source.curated,
      status: 'failed',
      error: String(err?.message ?? err),
    });
    return { source: source.id, runId, found: 0, queued: 0, error: String(err?.message ?? err) };
  }

  // Deduplicated by feed URL, not by host.
  //
  // The candidate queue is unique on (run_id, host), which is right for
  // keyword discovery — a search turns up many pages of one site and only the
  // site is interesting. It is wrong for a list of feeds: all 258 channels in
  // the YouTube list live on youtube.com, so a host key silently discards 257
  // of them and the run reports success. The key here is therefore the whole
  // addressable feed, and duplicates are caught by feed_url instead.
  const { urls: knownUrls } = await q.existingFeedKeys(db);
  const seen = new Set();

  const sites = [];
  for (const url of urls) {
    let key;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      // Path and query included, because that is what distinguishes one
      // channel's feed from another's on a shared host. Capped so a pathological
      // URL cannot bloat the row.
      key = `${host}${parsed.pathname}${parsed.search}`.slice(0, 180);
    } catch {
      continue;
    }

    if (knownUrls.has(url.toLowerCase()) || seen.has(key)) continue;
    seen.add(key);
    sites.push({ url, host: key });
  }

  const runId = await discovery.insertRun(db, {
    provider: source.id,
    category: source.category,
    curated: source.curated,
    // Queued rather than running: nothing is checked inline, the poller owns
    // all of it.
    status: sites.length > 0 ? 'queued' : 'complete',
    candidate_count: sites.length,
    queued_count: sites.length,
  });

  const queued = sites.length > 0 ? await discovery.insertCandidates(db, runId, sites) : 0;

  return { source: source.id, runId, found: urls.length, queued, error: null };
}

/**
 * Run whichever sources are due.
 *
 * One per pass, not all of them: each source is somebody else's server, and a
 * daemon that reads four lists the moment it boots — and again after any
 * restart — is a daemon that gets blocked.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ now?: Date, fetchImpl?: typeof fetch, max?: number }} [opts]
 * @returns {Promise<Array<{ source: string, runId: string|null, found: number, queued: number, error: string|null }>>}
 */
export async function runDueSources(db, opts = {}) {
  const lastRunAt = {};
  for (const source of await sourceSchedule(db)) lastRunAt[source.id] = source.lastRunAt;

  const due = dueSources(lastRunAt, opts.now ?? new Date());
  const results = [];

  for (const source of due.slice(0, opts.max ?? 1)) {
    results.push(await runSource(db, source.id, opts));
  }

  return results;
}

/**
 * When each source last ran.
 *
 * @param {import('@libsql/client').Client} db
 * @returns {Promise<Array<{ id: string, label: string, category: string|null, curated: boolean, lastRunAt: string|null }>>}
 */
export async function sourceSchedule(db) {
  const { SOURCES } = await import('./sources.js');

  return Promise.all(
    SOURCES.map(async (source) => ({
      id: source.id,
      label: source.label,
      category: source.category,
      curated: source.curated,
      lastRunAt: await discovery.lastRunAt(db, source.id),
    })),
  );
}

/**
 * How many feeds each source has actually contributed.
 *
 * The number that says whether a source is worth keeping: a list that queues
 * four hundred candidates and produces two feeds is four hundred requests to
 * somebody else's servers for two rows.
 *
 * @param {import('@libsql/client').Client} db
 * @returns {Promise<Record<string, number>>}
 */
export async function sourceYield(db) {
  const { rows } = await db.execute(`
    select r.provider, count(*) as n
    from feeds f
    join discovery_runs r on r.id = f.discovery_run_id
    group by r.provider
  `);

  return Object.fromEntries(rows.map((row) => [String(row.provider), Number(row.n ?? 0)]));
}

export { q };
