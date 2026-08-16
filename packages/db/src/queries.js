import { newId, nowIso } from './client.js';

/**
 * Every query the app needs, in one place.
 *
 * Keeping SQL out of the route handlers means the web app, the poller and the
 * CLI all hit the database the same way, and a schema change has one blast
 * radius instead of a dozen.
 *
 * @typedef {import('@libsql/client').Client} Client
 */

/** Columns exposed to callers; content_html is deliberately excluded from lists. */
const FEED_COLS = `id, slug, feed_url, site_url, title, description, language, image_url,
  author, categories, status, last_fetched_at, last_success_at, last_error, error_count,
  fetch_interval_minutes, next_fetch_at, item_count, created_at, updated_at`;

/**
 * @param {Client} db
 * @param {string} slug
 * @returns {Promise<object|null>}
 */
export async function feedBySlug(db, slug) {
  const { rows } = await db.execute({
    sql: `select ${FEED_COLS} from feeds where slug = ? limit 1`,
    args: [slug],
  });
  return rows[0] ?? null;
}

/**
 * @param {Client} db
 * @param {string} feedUrl
 * @returns {Promise<object|null>}
 */
export async function feedByUrl(db, feedUrl) {
  const { rows } = await db.execute({
    sql: `select ${FEED_COLS} from feeds where feed_url = ? limit 1`,
    args: [feedUrl],
  });
  return rows[0] ?? null;
}

/**
 * Newest feeds first, excluding dead ones by default.
 *
 * @param {Client} db
 * @param {{ limit?: number, offset?: number, includeDead?: boolean }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listFeeds(db, opts = {}) {
  const { limit = 60, offset = 0, includeDead = false } = opts;
  const { rows } = await db.execute({
    sql: `select ${FEED_COLS} from feeds
          ${includeDead ? '' : "where status <> 'dead'"}
          order by created_at desc limit ? offset ?`,
    args: [limit, offset],
  });
  return rows;
}

/**
 * @param {Client} db
 * @param {boolean} [includeDead]
 * @returns {Promise<number>}
 */
export async function countFeeds(db, includeDead = false) {
  const { rows } = await db.execute(
    `select count(*) as n from feeds ${includeDead ? '' : "where status <> 'dead'"}`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Slugs that could collide with `base` — `base`, `base-2`, `base-3`, …
 *
 * @param {Client} db
 * @param {string} base
 * @returns {Promise<Set<string>>}
 */
export async function takenSlugs(db, base) {
  const { rows } = await db.execute({
    sql: 'select slug from feeds where slug = ? or slug like ? limit 300',
    args: [base, `${base}-%`],
  });
  return new Set(rows.map((r) => String(r.slug)));
}

/**
 * Insert a feed.
 *
 * @param {Client} db
 * @param {object} feed
 * @returns {Promise<{ id: string, slug: string }>}
 */
export async function insertFeed(db, feed) {
  const id = newId();
  const now = nowIso();

  await db.execute({
    sql: `insert into feeds
      (id, slug, feed_url, site_url, title, description, language, image_url, author,
       categories, status, last_fetched_at, last_success_at, error_count,
       fetch_interval_minutes, next_fetch_at, item_count, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 60, ?, ?, ?, ?)`,
    args: [
      id,
      feed.slug,
      feed.feed_url,
      feed.site_url ?? null,
      feed.title,
      feed.description ?? null,
      feed.language ?? null,
      feed.image_url ?? null,
      feed.author ?? null,
      JSON.stringify(feed.categories ?? []),
      feed.status ?? 'active',
      now,
      now,
      nowIso(60 * 60_000),
      feed.item_count ?? 0,
      now,
      now,
    ],
  });

  return { id, slug: feed.slug };
}

/**
 * Insert items, ignoring ones already stored for this feed.
 *
 * Uses a single batch so one round trip covers the whole feed rather than one
 * per item — Turso is a network database and per-statement latency dominates.
 *
 * @param {Client} db
 * @param {string} feedId
 * @param {Array<object>} items
 * @returns {Promise<number>} statements sent
 */
export async function upsertItems(db, feedId, items) {
  const rows = items.filter((i) => i.guid);
  if (rows.length === 0) return 0;

  const now = nowIso();
  const statements = rows.map((i) => ({
    sql: `insert into feed_items
      (id, feed_id, guid, url, title, summary, content_html, author, image_url, published_at, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (feed_id, guid) do nothing`,
    args: [
      newId(),
      feedId,
      i.guid,
      i.url || null,
      i.title || '(untitled)',
      i.summary || null,
      i.contentHtml || null,
      i.author || null,
      i.imageUrl || null,
      i.publishedAt ?? null,
      now,
    ],
  }));

  await db.batch(statements, 'write');
  return statements.length;
}

/**
 * @param {Client} db
 * @param {string} feedId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function itemsForFeed(db, feedId, limit = 50) {
  const { rows } = await db.execute({
    sql: `select id, guid, url, title, summary, author, image_url, published_at
          from feed_items where feed_id = ?
          order by published_at desc nulls last, created_at desc
          limit ?`,
    args: [feedId, limit],
  });
  return rows;
}

/**
 * One post of a feed, by its guid.
 *
 * The reader addresses posts by guid rather than by URL on purpose: the URL it
 * frames then always comes out of our own database, so the reader cannot be
 * pointed at an arbitrary page by editing the query string.
 *
 * @param {Client} db
 * @param {string} feedId
 * @param {string} guid
 * @returns {Promise<object|null>}
 */
export async function itemByGuid(db, feedId, guid) {
  const { rows } = await db.execute({
    sql: `select id, guid, url, title, summary, author, image_url, published_at
          from feed_items where feed_id = ? and guid = ? limit 1`,
    args: [feedId, guid],
  });
  return rows[0] ?? null;
}

/**
 * @param {Client} db
 * @param {string} feedId
 * @returns {Promise<number>}
 */
export async function countItems(db, feedId) {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from feed_items where feed_id = ?',
    args: [feedId],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * A snapshot of what the crawler is doing, for /crawlstats.
 *
 * One round trip rather than a dozen counts: the page is public and uncached,
 * so the cost of rendering it has to stay flat as the directory grows. Every
 * figure comes out of the feeds table the poller already maintains — there is
 * no separate metrics store to drift out of step with reality.
 *
 * `stale` is the number the page leads with. A backlog (`due`) is normal and
 * drains; feeds whose last successful fetch is older than a day are the ones
 * that say something is actually wrong.
 *
 * @param {Client} db
 * @returns {Promise<object>}
 */
export async function crawlStats(db) {
  const now = nowIso();
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

  const { rows } = await db.execute({
    sql: `select
            count(*)                                                          as total,
            sum(case when status = 'active'  then 1 else 0 end)               as active,
            sum(case when status = 'pending' then 1 else 0 end)               as pending,
            sum(case when status = 'error'   then 1 else 0 end)               as errored,
            sum(case when status = 'dead'    then 1 else 0 end)               as dead,
            sum(case when status <> 'dead' and next_fetch_at <= ? then 1 else 0 end) as due,
            sum(case when last_fetched_at >= ? then 1 else 0 end)             as fetched_hour,
            sum(case when last_fetched_at >= ? then 1 else 0 end)             as fetched_day,
            sum(case when last_success_at >= ? then 1 else 0 end)             as succeeded_day,
            sum(case when status = 'active' and (last_success_at is null or last_success_at < ?)
                     then 1 else 0 end)                                       as stale,
            max(last_success_at)                                              as last_success_at,
            min(case when status <> 'dead' then next_fetch_at end)            as next_fetch_at
          from feeds`,
    args: [now, hourAgo, dayAgo, dayAgo, dayAgo],
  });

  const row = rows[0] ?? {};
  const items = await db.execute({
    sql: 'select count(*) as n from feed_items where created_at >= ?',
    args: [dayAgo],
  });

  return {
    total: Number(row.total ?? 0),
    active: Number(row.active ?? 0),
    pending: Number(row.pending ?? 0),
    errored: Number(row.errored ?? 0),
    dead: Number(row.dead ?? 0),
    due: Number(row.due ?? 0),
    fetchedLastHour: Number(row.fetched_hour ?? 0),
    fetchedLastDay: Number(row.fetched_day ?? 0),
    succeededLastDay: Number(row.succeeded_day ?? 0),
    staleActive: Number(row.stale ?? 0),
    itemsLastDay: Number(items.rows[0]?.n ?? 0),
    lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
    nextFetchAt: row.next_fetch_at ? String(row.next_fetch_at) : null,
    generatedAt: now,
  };
}

/**
 * The feeds failing right now, worst first, so a reader can see which blog is
 * broken rather than only that something is.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function failingFeeds(db, limit = 20) {
  const { rows } = await db.execute({
    sql: `select slug, title, feed_url, status, error_count, last_error,
                 last_fetched_at, last_success_at
          from feeds
          where status in ('error', 'dead')
          order by error_count desc, last_fetched_at desc
          limit ?`,
    args: [limit],
  });
  return rows;
}

/**
 * The most recently crawled feeds — the live end of the crawler's work.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function recentlyCrawled(db, limit = 20) {
  const { rows } = await db.execute({
    sql: `select slug, title, status, item_count, last_fetched_at, last_success_at
          from feeds
          where last_fetched_at is not null
          order by last_fetched_at desc
          limit ?`,
    args: [limit],
  });
  return rows;
}

/**
 * Feeds whose next_fetch_at has passed.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function dueFeeds(db, limit = 25) {
  const { rows } = await db.execute({
    sql: `select id, feed_url, error_count, fetch_interval_minutes from feeds
          where status <> 'dead' and next_fetch_at <= ?
          order by next_fetch_at asc limit ?`,
    args: [nowIso(), limit],
  });
  return rows;
}

/**
 * How many feeds are waiting to be crawled.
 *
 * The poller logs this so a backlog that never drains is visible without
 * opening the database — at directory scale that is the number that says
 * whether the crawler is keeping up.
 *
 * @param {Client} db
 * @returns {Promise<number>}
 */
export async function countDueFeeds(db) {
  const { rows } = await db.execute({
    sql: `select count(*) as n from feeds where status <> 'dead' and next_fetch_at <= ?`,
    args: [nowIso()],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Record a successful crawl.
 *
 * The caller supplies the next interval rather than it being fixed here: a
 * directory of tens of thousands of feeds cannot re-fetch every one of them
 * hourly, so a quiet blog earns a longer gap. See `nextIntervalMinutes`.
 *
 * @param {Client} db
 * @param {string} id
 * @param {object} feed parsed feed metadata
 * @param {number} itemCount
 * @param {number} [intervalMinutes]
 */
export async function markCrawlSuccess(db, id, feed, itemCount, intervalMinutes = 60) {
  const now = nowIso();
  await db.execute({
    sql: `update feeds set
            status = 'active', title = ?, description = ?, site_url = ?, image_url = ?,
            last_fetched_at = ?, last_success_at = ?, last_error = null, error_count = 0,
            fetch_interval_minutes = ?, next_fetch_at = ?, item_count = ?, updated_at = ?
          where id = ?`,
    args: [
      feed.title,
      feed.description || null,
      feed.siteUrl || null,
      feed.imageUrl || null,
      now,
      now,
      intervalMinutes,
      nowIso(intervalMinutes * 60_000),
      itemCount,
      now,
      id,
    ],
  });
}

/**
 * Insert many feeds in one round trip, skipping any that are already known.
 *
 * Bulk imports arrive as tens of thousands of rows from an OPML catalogue, and
 * the submit path cannot be reused for them: it fetches every feed before
 * inserting it, which would mean 47k outbound requests held open by one
 * process. These rows land as `pending` with the catalogue's own title, and the
 * poller fills in the real metadata when it first crawls each one.
 *
 * `on conflict do nothing` covers both unique columns, so a re-run of the same
 * catalogue is a no-op rather than an error.
 *
 * @param {Client} db
 * @param {Array<{ slug: string, feed_url: string, site_url?: string|null, title: string, next_fetch_at: string, submission_id?: string|null }>} feeds
 * @returns {Promise<number>} rows actually inserted
 */
export async function insertFeedsBulk(db, feeds) {
  if (feeds.length === 0) return 0;

  const now = nowIso();
  const statements = feeds.map((f) => ({
    sql: `insert into feeds
      (id, slug, feed_url, site_url, title, description, language, image_url, author,
       categories, status, last_fetched_at, last_success_at, last_error, error_count,
       fetch_interval_minutes, next_fetch_at, item_count, submission_id, created_at, updated_at)
      values (?, ?, ?, ?, ?, null, null, null, null, '[]', 'pending', null, null, null, 0,
              60, ?, 0, ?, ?, ?)
      on conflict do nothing`,
    args: [
      newId(),
      f.slug,
      f.feed_url,
      f.site_url ?? null,
      f.title,
      f.next_fetch_at,
      f.submission_id ?? null,
      now,
      now,
    ],
  }));

  const results = await db.batch(statements, 'write');
  return results.reduce((n, r) => n + Number(r.rowsAffected ?? 0), 0);
}

/**
 * Every feed_url and slug already in the directory.
 *
 * Read in pages because an import has to check ~50k rows against the table and
 * a single unbounded select of that size is the one query most likely to time
 * out against a remote libSQL server.
 *
 * @param {Client} db
 * @param {number} [pageSize]
 * @returns {Promise<{ urls: Set<string>, slugs: Set<string> }>}
 */
export async function existingFeedKeys(db, pageSize = 5000) {
  const urls = new Set();
  const slugs = new Set();

  for (let offset = 0; ; offset += pageSize) {
    const { rows } = await db.execute({
      sql: 'select feed_url, slug from feeds order by rowid limit ? offset ?',
      args: [pageSize, offset],
    });
    for (const row of rows) {
      urls.add(String(row.feed_url).toLowerCase());
      slugs.add(String(row.slug));
    }
    if (rows.length < pageSize) break;
  }

  return { urls, slugs };
}

/**
 * Record a failed crawl and push the next attempt out.
 *
 * @param {Client} db
 * @param {string} id
 * @param {string} error
 * @param {number} errorCount consecutive failures including this one
 * @param {number} minutes backoff
 */
export async function markCrawlFailure(db, id, error, errorCount, minutes) {
  const now = nowIso();
  await db.execute({
    sql: `update feeds set
            status = ?, last_fetched_at = ?, last_error = ?, error_count = ?,
            fetch_interval_minutes = ?, next_fetch_at = ?, updated_at = ?
          where id = ?`,
    args: [
      // Ten consecutive failures is a dead feed: stop crawling, keep the page.
      errorCount >= 10 ? 'dead' : 'error',
      now,
      error,
      errorCount,
      minutes,
      nowIso(minutes * 60_000),
      now,
      id,
    ],
  });
}

/**
 * Neighbouring slugs for the browsing toolbar, in index order.
 *
 * @param {Client} db
 * @param {string} createdAt
 * @returns {Promise<{ prev: string|null, next: string|null }>}
 */
export async function neighbours(db, createdAt) {
  const [prev, next] = await Promise.all([
    db.execute({
      sql: `select slug from feeds where created_at > ? and status <> 'dead'
            order by created_at asc limit 1`,
      args: [createdAt],
    }),
    db.execute({
      sql: `select slug from feeds where created_at < ? and status <> 'dead'
            order by created_at desc limit 1`,
      args: [createdAt],
    }),
  ]);

  return {
    prev: prev.rows[0]?.slug ? String(prev.rows[0].slug) : null,
    next: next.rows[0]?.slug ? String(next.rows[0].slug) : null,
  };
}

/**
 * A random non-dead feed, chosen by offset rather than ORDER BY RANDOM() so the
 * whole table is not sorted on every click.
 *
 * @param {Client} db
 * @returns {Promise<string|null>}
 */
export async function randomSlug(db) {
  const total = await countFeeds(db);
  if (total === 0) return null;

  const { rows } = await db.execute({
    sql: `select slug from feeds where status <> 'dead' limit 1 offset ?`,
    args: [Math.floor(Math.random() * total)],
  });
  return rows[0]?.slug ? String(rows[0].slug) : null;
}

/**
 * Escape a user query for FTS5.
 *
 * FTS5 treats bare punctuation as syntax, so an unescaped query like `C++` or
 * `foo AND` is a syntax error rather than a search. Wrapping each term in
 * double quotes makes every token a literal phrase; embedded quotes are doubled
 * per FTS5's own escaping rule.
 *
 * Quoting is also why a caller cannot smuggle its own operators in: `foo OR bar`
 * searches for the literal word "OR". Somebody who wants either term therefore
 * has no way to say so, which is what `mode` is for. It stays 'all' by default,
 * because a human typing several words into the box means all of them.
 *
 * @param {string} query
 * @param {'all'|'any'} [mode] 'all' requires every term, 'any' requires one
 * @returns {string}
 */
export function ftsQuery(query, mode = 'all') {
  const terms = String(query ?? '')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""').trim())
    .filter(Boolean)
    .map((t) => `"${t}"`);
  return terms.join(mode === 'any' ? ' OR ' : ' ');
}

/**
 * Full-text search over posts.
 *
 * @param {Client} db
 * @param {string} query
 * @param {number} [limit]
 * @param {'all'|'any'} [mode]
 * @returns {Promise<object[]>}
 */
export async function searchItems(db, query, limit = 40, mode = 'all') {
  const match = ftsQuery(query, mode);
  if (!match) return [];

  const { rows } = await db.execute({
    sql: `select i.guid, i.title, i.url, i.summary, i.published_at,
                 f.slug as feed_slug, f.title as feed_title
          from feed_items_fts
          join feed_items i on i.rowid = feed_items_fts.rowid
          join feeds f on f.id = i.feed_id
          where feed_items_fts match ?
          order by rank
          limit ?`,
    args: [match, limit],
  });
  return rows;
}

/**
 * Full-text search over blogs.
 *
 * @param {Client} db
 * @param {string} query
 * @param {number} [limit]
 * @param {'all'|'any'} [mode]
 * @returns {Promise<object[]>}
 */
export async function searchFeeds(db, query, limit = 20, mode = 'all') {
  const match = ftsQuery(query, mode);
  if (!match) return [];

  const { rows } = await db.execute({
    sql: `select f.slug, f.title, f.description
          from feeds_fts
          join feeds f on f.rowid = feeds_fts.rowid
          where feeds_fts match ?
          order by rank
          limit ?`,
    args: [match, limit],
  });
  return rows;
}

/**
 * @param {Client} db
 * @param {object} row
 * @returns {Promise<string>} the submission id, which is also its status URL
 */
export async function insertSubmission(db, row) {
  // The caller may supply the id: a queued submission has to stamp its feeds
  // with it before the submission row itself is written.
  const id = row.id ?? newId();

  await db.execute({
    sql: `insert into submissions
      (id, kind, raw_input, accepted_count, rejected_count, errors, ip_hash, user_agent,
       queued_count, notify_email, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      row.kind,
      row.raw_input ?? null,
      row.accepted_count ?? 0,
      row.rejected_count ?? 0,
      JSON.stringify(row.errors ?? []),
      row.ip_hash ?? null,
      row.user_agent ?? null,
      row.queued_count ?? 0,
      row.notify_email ?? null,
      nowIso(),
    ],
  });

  return id;
}

/**
 * @param {Client} db
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function submissionById(db, id) {
  const { rows } = await db.execute({
    sql: `select id, kind, accepted_count, rejected_count, queued_count, errors,
                 notify_email, notified_at, created_at
          from submissions where id = ? limit 1`,
    args: [id],
  });
  return rows[0] ?? null;
}

/**
 * How far through its queue one submission is.
 *
 * Counted from the feeds themselves rather than a stored counter: the poller
 * already updates each row as it crawls it, and a second tally kept in step
 * with that would be one more thing to drift.
 *
 * @param {Client} db
 * @param {string} id
 * @returns {Promise<{ queued: number, crawled: number, failed: number, waiting: number }>}
 */
export async function submissionProgress(db, id) {
  const { rows } = await db.execute({
    sql: `select status, count(*) as n from feeds where submission_id = ? group by status`,
    args: [id],
  });

  const by = Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
  const crawled = by.active ?? 0;
  const failed = (by.error ?? 0) + (by.dead ?? 0);
  const waiting = by.pending ?? 0;

  return { queued: crawled + failed + waiting, crawled, failed, waiting };
}

/**
 * Submissions that asked for an email and whose queue has fully drained.
 *
 * The `not exists` clause is the whole point: a submission is only finished
 * when none of its feeds are still pending, and asking that per candidate is
 * cheaper than counting every feed of every open submission.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function submissionsAwaitingNotice(db, limit = 5) {
  const { rows } = await db.execute({
    sql: `select id, kind, notify_email, accepted_count, queued_count, created_at
          from submissions s
          where s.notify_email is not null
            and s.notified_at is null
            and not exists (
              select 1 from feeds f
              where f.submission_id = s.id and f.status = 'pending'
            )
          order by s.created_at asc
          limit ?`,
    args: [limit],
  });
  return rows;
}

/**
 * @param {Client} db
 * @param {string} id
 */
export async function markSubmissionNotified(db, id) {
  await db.execute({
    sql: 'update submissions set notified_at = ? where id = ?',
    args: [nowIso(), id],
  });
}

/**
 * Submissions from one hashed IP within a window — the rate limiter.
 *
 * @param {Client} db
 * @param {string} ipHash
 * @param {number} [windowMs]
 * @returns {Promise<number>}
 */
export async function submissionCount(db, ipHash, windowMs = 3_600_000) {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from submissions where ip_hash = ? and created_at >= ?',
    args: [ipHash, nowIso(-windowMs)],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * The first `limit` feeds in export order.
 *
 * A capped sample, for callers that genuinely want the head of the list rather
 * than the directory — llms.txt, which is a summary document. Anything that
 * claims to be a complete export must use {@link eachFeedForExport} instead;
 * this one truncates silently by design.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function allFeedsForExport(db, limit = 5000) {
  const { rows } = await db.execute({
    sql: `select slug, title, feed_url, site_url, description, item_count, updated_at
          from feeds where status <> 'dead' order by title asc, id asc limit ?`,
    args: [limit],
  });
  return rows;
}

/**
 * One page of the export ordering, resumed from a cursor.
 *
 * Keyset paging rather than OFFSET: SQLite answers OFFSET by walking and
 * discarding the rows before it, so exporting the whole table page by page
 * would cost O(n²) row visits. Comparing against the last row seen instead lets
 * every page start where the previous one stopped.
 *
 * The cursor is (title, id), not title alone — titles are not unique in this
 * directory, and a cursor on a duplicated title would either skip the rest of
 * that title or repeat it forever. `id` is the primary key, so the pair is.
 *
 * @param {Client} db
 * @param {{ afterTitle?: string|null, afterId?: string|null, limit?: number }} [cursor]
 * @returns {Promise<object[]>}
 */
export async function feedsForExportPage(db, { afterTitle = null, afterId = null, limit = 2000 } = {}) {
  const resuming = afterTitle !== null && afterId !== null;

  const { rows } = await db.execute({
    sql: `select id, slug, title, feed_url, site_url, description, item_count, updated_at
          from feeds
          where status <> 'dead'
            ${resuming ? 'and (title > ? or (title = ? and id > ?))' : ''}
          order by title asc, id asc
          limit ?`,
    args: resuming ? [afterTitle, afterTitle, afterId, limit] : [limit],
  });
  return rows;
}

/**
 * Every non-dead feed, in export order, a page at a time.
 *
 * Yields rows instead of returning an array so a full export never holds the
 * whole directory in memory — it is tens of thousands of rows and only grows,
 * and the endpoints that use it stream their output as the pages arrive.
 *
 * @param {Client} db
 * @param {number} [pageSize]
 * @returns {AsyncGenerator<object, void, void>}
 */
export async function* eachFeedForExport(db, pageSize = 2000) {
  let afterTitle = null;
  let afterId = null;

  for (;;) {
    const rows = await feedsForExportPage(db, { afterTitle, afterId, limit: pageSize });
    if (rows.length === 0) return;

    for (const row of rows) yield row;

    const last = rows[rows.length - 1];
    afterTitle = String(last.title ?? '');
    afterId = String(last.id ?? '');

    // A short page means the cursor reached the end; asking again would only
    // cost a round trip to learn the same thing.
    if (rows.length < pageSize) return;
  }
}

/**
 * The month a timestamp falls in, and the month after it.
 *
 * Sitemap chunks are selected with a half-open range on created_at rather than
 * substr(created_at, 1, 7) = ?, because a function of the column cannot use the
 * index — the range can. ISO-8601 sorts lexically, so string bounds are correct
 * bounds.
 *
 * @param {string} month `YYYY-MM`
 * @returns {{ from: string, to: string }}
 */
export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    from: `${month}-`,
    to: `${String(nextY).padStart(4, '0')}-${String(nextM).padStart(2, '0')}-`,
  };
}

/**
 * The chunks a sitemap index has to list.
 *
 * Feeds are grouped by the month they were added, so a month that has passed
 * never changes shape again: a blog submitted today lands in this month's file
 * and leaves every earlier file byte-identical, which is what lets a crawler
 * skip the ones it already has. Ordering inside a chunk is (created_at, id) for
 * the same reason the OPML export uses a compound key — timestamps collide in
 * bulk imports, and the primary key breaks the tie.
 *
 * A month is split into parts when it exceeds `chunkSize`, because the sitemap
 * spec caps a single file at 50,000 URLs and one bulk import can put a year's
 * worth of blogs in one month. Part 1 keeps the bare `YYYY-MM` name so the
 * common case — a month that fits — reads the same as everywhere else.
 *
 * @param {Client} db
 * @param {number} [chunkSize]
 * @returns {Promise<Array<{ month: string, part: number, count: number, lastmod: string|null }>>}
 */
export async function sitemapChunks(db, chunkSize = 20_000) {
  const { rows } = await db.execute(`
    select substr(created_at, 1, 7) as month,
           count(*)                 as n,
           max(updated_at)          as lastmod
    from feeds
    where status <> 'dead'
    group by month
    order by month asc
  `);

  const chunks = [];
  for (const row of rows) {
    const month = String(row.month);
    const count = Number(row.n);
    const parts = Math.max(1, Math.ceil(count / chunkSize));

    for (let part = 1; part <= parts; part += 1) {
      chunks.push({
        month,
        part,
        count: part === parts ? count - chunkSize * (parts - 1) : chunkSize,
        lastmod: row.lastmod ? String(row.lastmod) : null,
      });
    }
  }
  return chunks;
}

/**
 * One sitemap chunk's worth of feeds.
 *
 * OFFSET is fine here where it was not in the OPML export: each chunk is its
 * own request with its own bounded scan, so the cost is paid once per file
 * rather than compounding across a single streamed response.
 *
 * @param {Client} db
 * @param {{ month: string, part?: number, chunkSize?: number }} chunk
 * @returns {Promise<object[]>}
 */
export async function feedsForSitemapChunk(db, { month, part = 1, chunkSize = 20_000 }) {
  const { from, to } = monthBounds(month);

  const { rows } = await db.execute({
    sql: `select slug, updated_at
          from feeds
          where status <> 'dead' and created_at >= ? and created_at < ?
          order by created_at asc, id asc
          limit ? offset ?`,
    args: [from, to, chunkSize, (part - 1) * chunkSize],
  });
  return rows;
}
