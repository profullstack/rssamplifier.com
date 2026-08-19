import { clusterKey, dedupeItems, topicSlug } from '@rssamplifier/feed';

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
// The scheduling signals on the last line are not read by any page, and they are
// here anyway. `crawlFeed` takes a feed row and decides from these four columns
// whether to ask conditionally and whether the contents changed; handed a row
// selected without them it cannot tell "this column was not selected" from "this
// feed has no fingerprint yet", so it concludes the feed has changed -- every
// time, for ever. That pins the feed at the floor and writes a change-log entry
// per crawl, which then reads back as a feed publishing hourly. Nothing errors.
// They are a few hundred bytes next to `description` and `categories`, which is
// a cheap price for a failure mode that would be invisible.
const FEED_COLS = `id, slug, feed_url, site_url, title, description, language, image_url,
  author, categories, kind, category, category_source, status, last_fetched_at, last_success_at, last_error, error_count,
  fetch_interval_minutes, next_fetch_at, item_count, last_published_at, created_at, updated_at, source_kind,
  card_url, card_width, card_height, card_type, authors_checked_at,
  http_etag, http_last_modified, content_hash, change_log`;

/** The categories the directory is browsable by. */
export const KINDS = ['blog', 'news', 'podcast', 'music', 'video', 'comic', 'live', 'reel'];

/**
 * The categories a crawler can work out for itself.
 *
 * `comic` and `reel` are absent on purpose. A webcomic's feed is a blog with
 * pictures in it as far as any parser is concerned; RSS has no way to say "this
 * one is a short", and YouTube's feed does not mark one — that needs the
 * platform's own API. Those two only ever arrive from a curated list. See
 * `category_source` in 0013.
 *
 * `live` was among them until playlists were indexed. RSS still cannot state
 * it, but HLS can and does: a manifest with no `#EXT-X-ENDLIST` is a
 * broadcaster saying the stream has not finished. See packages/feed/src/kinds.js.
 *
 * `news` is derived, but only where the evidence is unarguable — a newsroom and
 * a blog publish the same document, so `isNewsroom` wants two independent
 * signals and lets the quiet section feeds go. It is the one category that is
 * routinely both: detected for the wires, curated for the rest.
 */
export const DERIVED_KINDS = ['blog', 'news', 'podcast', 'music', 'video', 'live'];

/**
 * Read a caller-supplied kind, rejecting anything that is not one.
 *
 * Kind reaches the queries from a URL (`/api/feeds?kind=…`), so it is
 * interpolated nowhere and validated here once rather than being trusted at
 * each call site.
 *
 * @param {unknown} kind
 * @returns {string|null} null meaning "every kind"
 */
export function normalizeKind(kind) {
  const value = String(kind ?? '').toLowerCase();
  return KINDS.includes(value) ? value : null;
}

/**
 * Read a set of kinds, keeping only the real ones.
 *
 * A topic's sub-groups are mostly one kind each, but not all of them: "audio"
 * is podcasts and music together, because a listener looking for something to
 * put on does not care which of the two a feed was filed as. So the queries
 * take a set rather than a kind, and a set of one covers the ordinary case.
 *
 * Returns null — meaning "every kind", the same as passing nothing — when
 * nothing usable survives, so a caller that guessed a category name gets the
 * whole topic instead of an empty page.
 *
 * @param {unknown} kinds
 * @returns {string[]|null}
 */
export function normalizeKinds(kinds) {
  const list = (Array.isArray(kinds) ? kinds : [kinds])
    .map((kind) => normalizeKind(kind))
    .filter((kind) => kind !== null);

  return list.length > 0 ? [...new Set(list)] : null;
}

/**
 * A `category in (…)` fragment and its arguments, or nothing at all.
 *
 * Placeholders rather than interpolation even though `normalizeKinds` has
 * already rejected anything that is not a known kind: the validation is what
 * makes it safe, and the placeholders are what keep it safe if somebody later
 * calls this with a value that skipped the validation.
 *
 * @param {string[]|null} kinds
 * @param {string} [column]
 * @returns {{ sql: string, args: string[] }}
 */
function kindFilter(kinds, column = 'f.category') {
  if (!kinds || kinds.length === 0) return { sql: '', args: [] };
  return { sql: ` and ${column} in (${kinds.map(() => '?').join(', ')})`, args: kinds };
}

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
 * `kind` narrows the list to one category page's worth. The tie-break on id is
 * not cosmetic: the directory was bulk imported, so tens of thousands of rows
 * share a created_at to the second, and paging by OFFSET through an order that
 * leaves those rows unsorted relative to each other shows a blog twice on one
 * page and never on the next.
 *
 * @param {Client} db
 * @param {{ limit?: number, offset?: number, includeDead?: boolean, kind?: string|null }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listFeeds(db, opts = {}) {
  const { limit = 60, offset = 0, includeDead = false, kind = null } = opts;
  const where = [];
  const args = [];

  if (!includeDead) where.push("status <> 'dead'");
  if (kind) {
    where.push('category = ?');
    args.push(kind);
  }

  const { rows } = await db.execute({
    sql: `select ${FEED_COLS} from feeds
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by created_at desc, id desc limit ? offset ?`,
    args: [...args, limit, offset],
  });
  return rows;
}

/**
 * @param {Client} db
 * @param {boolean} [includeDead]
 * @param {string|null} [kind] one category, or null for the whole directory
 * @returns {Promise<number>}
 */
export async function countFeeds(db, includeDead = false, kind = null) {
  const where = [];
  const args = [];

  if (!includeDead) where.push("status <> 'dead'");
  if (kind) {
    where.push('category = ?');
    args.push(kind);
  }

  const { rows } = await db.execute({
    sql: `select count(*) as n from feeds ${where.length ? `where ${where.join(' and ')}` : ''}`,
    args,
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * File feeds under a category by hand, and make it stick.
 *
 * The categories a parser cannot see — comics, lives, reels — come from
 * curated lists, and marking them `curated` is what stops the next crawl from
 * re-deriving them back to 'blog'. Addressed by feed_url because that is what
 * a curated list actually contains; a list is a list of feeds, not of our ids.
 *
 * @param {Client} db
 * @param {string[]} feedUrls
 * @param {string} category
 * @returns {Promise<number>} rows recategorised
 */
export async function curateCategory(db, feedUrls, category) {
  const kind = normalizeKind(category);
  if (!kind || feedUrls.length === 0) return 0;

  const statements = feedUrls.map((url) => ({
    sql: `update feeds set category = ?, category_source = 'curated', updated_at = ?
          where feed_url = ?`,
    args: [kind, nowIso(), url],
  }));

  const results = await db.batch(statements, 'write');
  return results.reduce((n, r) => n + Number(r.rowsAffected ?? 0), 0);
}

/**
 * How many feeds of each kind the directory holds.
 *
 * One grouped scan rather than a count per category: the numbers are shown side
 * by side, and asking twice for the same aggregate is two scans of the same
 * table plus a window in which they disagree.
 *
 * Every kind is present in the result whether or not the directory has one yet,
 * so a caller can render "0 podcasts" instead of nothing at all.
 *
 * @param {Client} db
 * @returns {Promise<Record<string, number>>}
 */
export async function countFeedsByKind(db) {
  const { rows } = await db.execute(
    `select category, count(*) as n from feeds where status <> 'dead' group by category`,
  );

  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const row of rows) counts[String(row.category)] = Number(row.n ?? 0);
  return counts;
}

/**
 * Slugs that could collide with `base` — `base`, `base-2`, `base-3`, …
 *
 * Deliberately unlimited. It used to say `limit 300`, which is fine for the one
 * thing this was written for — settling a single submission — and quietly wrong
 * for a bulk import: `uniqueSlug` walks base, base-2, base-3 … and takes the
 * first slug this set does not contain, so a truncated set hands back a slug
 * that is already in use. `insertFeedsBulk` says `on conflict do nothing`, so
 * the row was then dropped without a word. Measured: importing two thousand
 * feeds that shared a title into a directory already holding two thousand of
 * them queued three hundred and silently lost the rest.
 *
 * The unbounded read is affordable because it is bounded by reality rather than
 * by the table: it matches one base's variants, not the directory, and the
 * caller asks once per base. The slug column is unique and therefore indexed,
 * and the `like` is a literal prefix, so this is an index range scan.
 *
 * @param {Client} db
 * @param {string} base
 * @returns {Promise<Set<string>>}
 */
export async function takenSlugs(db, base) {
  const { rows } = await db.execute({
    sql: 'select slug from feeds where slug = ? or slug like ?',
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
       categories, category, status, last_fetched_at, last_success_at, error_count,
       fetch_interval_minutes, next_fetch_at, item_count, created_at, updated_at,
       discovery_run_id, source_kind)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 60, ?, ?, ?, ?, ?, ?)`,
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
      normalizeKind(feed.kind) ?? 'blog',
      feed.status ?? 'active',
      now,
      now,
      nowIso(60 * 60_000),
      feed.item_count ?? 0,
      now,
      now,
      feed.discovery_run_id ?? null,
      feed.source_kind === 'scraped' ? 'scraped' : 'feed',
    ],
  });

  return { id, slug: feed.slug };
}

/**
 * Insert items, ignoring ones already stored for this feed.
 *
 * Uses one multi-row statement so one round trip covers the whole feed rather
 * than one per item — Turso is a network database and request latency dominates.
 *
 * @param {Client} db
 * @param {string} feedId
 * @param {Array<object>} items
 * @returns {Promise<number>} items offered
 */
export async function upsertItems(db, feedId, items) {
  const statement = itemStatement(feedId, items, nowIso());
  if (!statement) return 0;

  await db.execute(statement);
  // How many items were **offered**, not how many were new. Every crawl re-sends
  // the whole document and the conflict clause updates the rows already there,
  // so there is no cheap way to tell the two apart here — and reading this as
  // "new items" silently disables the crawler's backoff. `crawlFeed` derives the
  // real figure from the change in the stored total.
  return statement.rows;
}

/**
 * One multi-row insert-or-update for the items in a feed document.
 *
 * A multi-row statement is important on the remote database: ten individual
 * autocommit requests are ten network round trips and ten turns through the
 * writer, while this is one of each. It also gives catch-up mode a bounded
 * critical path without opening the explicit transaction lane that is
 * currently taking tens of seconds even for `select 1`.
 *
 * @param {string} feedId
 * @param {object[]} items
 * @param {string} now
 * @returns {{ sql: string, args: unknown[], rows: number }|null}
 */
function itemStatement(feedId, items, now) {
  // Newest first, then capped. A feed that ships its entire archive -- and they
  // exist, up to 1,494 entries in a production sample -- otherwise costs a
  // single first crawl one row-write per entry, and there are 302k feeds in the
  // queue that have never been read. Capping the *write* rather than the stored
  // total is what keeps the archive growing: later crawls add whatever is new,
  // so a feed accumulates history at the rate it publishes instead of arriving
  // all at once.
  //
  // Undated items sort last rather than being dropped: plenty of the small web
  // publishes no dates at all, and a feed with none would otherwise have its
  // items chosen arbitrarily.
  const rows = items
    .filter((i) => i.guid)
    .slice()
    .sort((a, b) => published(b) - published(a))
    .slice(0, ITEMS_PER_CRAWL);

  if (rows.length === 0) return null;

  const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',\n        ');
  return {
    sql: `insert into feed_items
      (id, feed_id, guid, url, title, summary, content_chars, author, image_url, published_at,
       categories, audio_url, audio_type, audio_bytes, audio_seconds, created_at, cluster_key)
      values ${placeholders}
      on conflict (feed_id, guid) do update set
        -- An episode already stored keeps its row, but a re-crawl fills in the
        -- audio it was stored without. Items imported before the media columns
        -- existed would otherwise never gain a player, because the guid is
        -- already there and a do-nothing conflict skips the whole row.
        --
        -- The picture heals the same way, and for a bigger population: the
        -- parser only ever read media:thumbnail and an image enclosure, so
        -- four fifths of the posts in the directory were stored without one
        -- that their feed was in fact carrying. This is the whole backfill --
        -- every feed is re-crawled on its own timer, so the column fills in
        -- over one crawl cycle with no migration and no script to remember.
        --
        -- coalesce, and not excluded.image_url outright: a post whose picture
        -- we already have keeps it even if the publisher's feed has since
        -- dropped the element, and a listing never loses a thumbnail it was
        -- showing yesterday.
        image_url = coalesce(feed_items.image_url, excluded.image_url),
        audio_url = coalesce(feed_items.audio_url, excluded.audio_url),
        audio_type = coalesce(feed_items.audio_type, excluded.audio_type),
        audio_bytes = coalesce(feed_items.audio_bytes, excluded.audio_bytes),
        audio_seconds = coalesce(feed_items.audio_seconds, excluded.audio_seconds),
        content_chars = coalesce(feed_items.content_chars, excluded.content_chars)
      -- The guard, and the reason it is worth the five lines.
      --
      -- Every crawl re-offers the publisher's entire document, so this conflict
      -- clause fires for every item the feed still lists -- and until this
      -- WHERE existed it *rewrote* every one of those rows to assign them the
      -- values they already held. With ~62k active feeds carrying ~250 items
      -- each, a single pass over the directory was millions of row-writes that
      -- changed nothing. The account was at 286% of its rows-written quota.
      --
      -- It buys no latency: a write transaction against this database costs the
      -- same whatever is inside it (a 1-row upsert, a 100-row upsert and a
      -- no-op all measured 30-50 seconds), so skipping the row work does not
      -- make the crawl faster. What it buys is quota, which is what is
      -- throttling the writes in the first place.
      --
      -- Every branch mirrors a coalesce above: update only if this crawl can
      -- actually fill in something the stored row is missing.
      where (feed_items.image_url is null and excluded.image_url is not null)
         or (feed_items.audio_url is null and excluded.audio_url is not null)
         or (feed_items.audio_type is null and excluded.audio_type is not null)
         or (feed_items.audio_bytes is null and excluded.audio_bytes is not null)
         or (feed_items.audio_seconds is null and excluded.audio_seconds is not null)
         or (feed_items.content_chars is null and excluded.content_chars is not null)`,
    args: rows.flatMap((i) => [
        newId(),
        feedId,
        i.guid,
        i.url || null,
        i.title || '(untitled)',
        i.summary || null,
        // The length, not the body -- see 0031. Payload size genuinely does not
        // decide how long a single write takes here (a 1.1 MB batch beat a 12 KB
        // one), but it decides how big the database gets, and size is what makes
        // write slots scarce. This column was 10 GB of 14. The body a reader
        // actually opens is fetched then and cached in `item_extracts`; the only
        // question ever asked of the stored copy was how long it was.
        textLength(i.contentHtml),
        i.author || null,
        i.imageUrl || null,
        i.publishedAt ?? null,
        JSON.stringify(Array.isArray(i.categories) ? i.categories : []),
        i.audio?.url ?? null,
        i.audio?.type ?? null,
        i.audio?.bytes ?? null,
        i.audio?.seconds ?? null,
        now,
        // Computed on the way in, so the river never pays for it. An empty string
        // means "looked at, deliberately not groupable"; NULL is reserved for
        // rows the backfill worker has not reached yet, and writing NULL here
        // would put every new item back into its queue forever.
        clusterKey(i.title || '') ?? '',
      ]),
    rows: rows.length,
  };
}

/**
 * How many items one crawl may write.
 *
 * Not how many a feed may have. See `itemStatement`: a crawl stores the newest
 * this many, and the next crawl stores whatever has appeared since, so a feed's
 * archive still grows -- it just stops arriving in one 1,500-row transaction on
 * a database whose write path is the scarce resource.
 */
const ITEMS_PER_CRAWL = Number(process.env['ITEMS_PER_CRAWL']) || 50;

/**
 * Catch-up mode avoids Turso's pathologically slow explicit transaction lane.
 * This is opt-in because a local SQLite file has no network lock queue and is
 * better served by the atomic transaction below.
 */
const CRAWL_AUTOCOMMIT = ['1', 'true'].includes(
  String(process.env['TURSO_CRAWL_AUTOCOMMIT'] ?? '').toLowerCase(),
);

/** @type {WeakMap<Client, Promise<unknown>>} */
const crawlWriteTails = new WeakMap();

/**
 * An item's publication time as a number, for sorting. Undated sorts last.
 *
 * @param {{ publishedAt?: unknown }} item
 * @returns {number}
 */
function published(item) {
  const t = Date.parse(String(item?.publishedAt ?? ''));
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * How much text a body carries, with the markup taken out.
 *
 * Deliberately identical to `textLength` in apps/web/src/lib/media.js, which is
 * where this measurement is consumed and where it used to be taken. It moved to
 * the write path when the body stopped being stored: the reader cannot measure
 * what it is not given, so the crawl measures it once instead.
 *
 * @param {unknown} html
 * @returns {number|null} null when the feed shipped no body at all, which is
 *   different from an empty one and is what the coalesce above relies on.
 */
function textLength(html) {
  if (html === null || html === undefined) return null;
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}


/**
 * Store a crawl's items and settle the feed row.
 *
 * This is `upsertItems` + `countItems` + `markCrawlSuccess` fused, and the
 * reason to fuse them is that against this database a write transaction costs
 * essentially the same whatever is inside it. Measured on production, an
 * *empty* write transaction — `select 1` submitted in write mode, touching
 * nothing — took **29 to 118 seconds**, while a read took 100ms and a plain
 * select of 100 items took 90ms. A 100-row upsert and a 1-row upsert and a
 * no-op all landed within noise of each other. The cost is acquiring the write
 * path at all, not the work done once it is held.
 *
 * Ordinarily these statements use one atomic transaction. During a large
 * first-crawl catch-up, production can set `TURSO_CRAWL_AUTOCOMMIT=1`: items
 * become one multi-row autocommit and the feed row becomes a second. Those two
 * writes are serialized in-process, because SQLite still has one writer and
 * making six workers race merely moves the queue back to the database. If the
 * first statement lands and the second fails, the feed remains due and the
 * idempotent item upsert is retried; partial progress is therefore safe.
 *
 * The interval ladder is duplicated across two SET expressions rather than
 * computed once, which looks like a mistake and is not: SQLite evaluates every
 * right-hand side of an UPDATE against the **old** row, so `next_fetch_at` has
 * to re-derive the same interval it cannot read back from
 * `fetch_interval_minutes`. Both copies must stay in step with
 * `nextIntervalMinutes` in packages/ingest/src/crawl.js, which is the JS
 * statement of the same ladder and the one the tests exercise.
 *
 * @param {Client} db
 * @param {string} id feed id
 * @param {object[]} items parsed items, as `upsertItems` takes them
 * @param {object} feed parsed feed metadata, as `markCrawlSuccess` takes it
 * @param {number} previousItemCount `item_count` from the due row
 * @param {number|null} intervalMinutes the interval the caller worked out, or
 *   null to let the SQL ladder below decide
 * @param {string|null} lastPublishedAt newest believable date in the document
 * @param {Array<{ sql: string, args: unknown[] }>} extra topics and credits
 * @param {{ etag?: string|null, lastModified?: string|null, contentHash?: string|null, changeLog?: string|null }} [signals]
 *   what this crawl learned about when to come back -- see migration 0032. An
 *   object rather than four more positional parameters, which at this arity is
 *   the difference between a readable call site and a row of nulls nobody can
 *   count. Every field is written with `coalesce(?, column)`, so omitting one
 *   keeps what was there rather than clearing it: a server that stopped sending
 *   an ETag has not told us the old one is wrong about anything else.
 * @returns {Promise<{ total: number, stored: number }>} `stored` is the change
 *   in the stored total — posts actually new, not posts offered.
 */
export async function storeCrawl(
  db,
  id,
  items,
  feed,
  previousItemCount = 0,
  intervalMinutes = null,
  lastPublishedAt = null,
  extra = [],
  signals = {},
) {
  const now = nowIso();
  const before = Number(previousItemCount) || 0;

  // How long until this feed is read again, and there are two ways to know.
  //
  // Usually the caller has already worked it out from the dates in the document
  // it just parsed — see `intervalFromDates` in packages/ingest/src/cadence.js,
  // which schedules a feed on its own publishing rhythm rather than on a fixed
  // ladder. That is by far the better answer and it is free, since the document
  // is in hand either way.
  //
  // When the document carries no usable dates the caller passes null, and the
  // fallback below has to be evaluated in SQL rather than in JS: it depends on
  // whether this crawl actually stored anything, and that is not known until
  // this very statement has run. It is the old ladder verbatim — floor 60,
  // double a quiet feed, ceiling one day.
  const chosen = Number(intervalMinutes);
  const LADDER = Number.isFinite(chosen) && chosen > 0
    ? String(Math.round(chosen))
    : `case when (select count(*) from feed_items where feed_id = ?) > ?
             then 60
             else min(max(coalesce(fetch_interval_minutes, 60), 60) * 2, 1440) end`;
  // The ladder binds two parameters; a literal interval binds none, so the
  // argument list has to follow it. Getting this wrong shifts every later
  // parameter by two and is exactly the kind of silent corruption that a
  // scheduling column does not advertise, so it is derived rather than typed.
  const ladderArgs = LADDER.startsWith('case') ? [id, before] : [];

  const settle = {
    sql: `update feeds set
            status = 'active', title = ?, description = ?, site_url = ?, image_url = ?,
            category = case when category_source = 'curated' then category else ? end,
            language = coalesce(nullif(?, ''), language),
            last_fetched_at = ?, last_success_at = ?, last_error = null,
            error_count = 0,
            fetch_interval_minutes = ${LADDER},
            -- strftime's %f is 'SS.SSS', so this produces exactly the
            -- 'YYYY-MM-DDTHH:MM:SS.sssZ' that nowIso() writes elsewhere. The
            -- due query compares next_fetch_at as a string, so a format that
            -- merely sorts differently would quietly break scheduling.
            next_fetch_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || (${LADDER}) || ' minutes'),
            item_count = (select count(*) from feed_items where feed_id = ?),
            -- Kept when a crawl cannot work one out, rather than overwritten
            -- with nothing: a date that was true last week is a better answer
            -- than null, and null here reads to a caller as "we do not know
            -- whether this publisher is still active" -- which would be a
            -- worse claim than the one we already had.
            last_published_at = coalesce(?, last_published_at),
            -- Kept rather than cleared when this crawl has nothing to say about
            -- them, for the same reason as last_published_at above. A server
            -- that answered without an ETag this once has not retracted the one
            -- it gave us last time, and dropping it would turn every later
            -- request back into an unconditional one.
            http_etag = coalesce(?, http_etag),
            http_last_modified = coalesce(?, http_last_modified),
            content_hash = coalesce(?, content_hash),
            change_log = coalesce(?, change_log),
            updated_at = ?
          where id = ?
          returning item_count`,
    args: [
      feed.title,
      feed.description || null,
      feed.siteUrl || null,
      feed.imageUrl || null,
      normalizeKind(feed.kind) ?? 'blog',
      feed.language || null,
      now,
      now,
      ...ladderArgs, // fetch_interval_minutes
      ...ladderArgs, // next_fetch_at
      id, // item_count
      lastPublishedAt,
      signals.etag ?? null,
      signals.lastModified ?? null,
      signals.contentHash ?? null,
      signals.changeLog ?? null,
      now,
      id,
    ],
  };

  const item = itemStatement(id, items, now);

  if (CRAWL_AUTOCOMMIT) {
    return serializeCrawlWrite(db, async () => {
      if (item) await db.execute(item);
      const result = await db.execute(settle);

      // Auxiliary writes are disabled in production catch-up mode. Keeping
      // this path complete makes the switch safe if it is enabled elsewhere;
      // they run only after the critical feed row has settled, so a missing
      // topic or credit cannot leave a healthy feed permanently due.
      for (const statement of extra) await db.execute(statement);

      const total = Number(result.rows?.[0]?.item_count ?? before);
      return { total, stored: Math.max(0, total - before) };
    });
  }

  // `extra` is everything else this crawl decided to write -- the feed's topics
  // and its credits -- carried into the same transaction rather than opening
  // two more of their own. It goes *after* the feed row so that a failure
  // anywhere rolls back a crawl that had not been recorded yet, rather than one
  // that had.
  const statements = [...(item ? [item] : []), settle, ...extra];
  const results = await db.batch(statements, 'write');

  // Indexed rather than taken from the end: `extra` now sits behind the feed
  // row, so "the last result" stopped being the one carrying RETURNING. Reading
  // the wrong result here would silently report every crawl as storing nothing,
  // which is precisely the bug that once pinned the whole directory to an
  // hourly re-crawl.
  const settleIndex = results.length - extra.length - 1;
  const total = Number(results[settleIndex]?.rows?.[0]?.item_count ?? before);
  return { total, stored: Math.max(0, total - before) };
}

/**
 * Run one feed's autocommit writes after the previous feed has released the
 * writer. Fetching remains concurrent; only the database's single-writer
 * section queues here.
 *
 * @template T
 * @param {Client} db
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function serializeCrawlWrite(db, task) {
  const previous = crawlWriteTails.get(db) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  crawlWriteTails.set(db, current);

  try {
    return await current;
  } finally {
    if (crawlWriteTails.get(db) === current) crawlWriteTails.delete(db);
  }
}

/**
 * Give one batch of older items a grouping key.
 *
 * Every item stored from now on is keyed as it arrives, so this exists only for
 * the rows that predate the column — of which there are millions. It runs as a
 * step of the poller's ordinary tick rather than as a migration or a one-off
 * script: a single statement over the whole table would hold a write open on a
 * network database for minutes, and a script is a thing somebody has to
 * remember to run and to finish.
 *
 * It searches for `cluster_key is null` directly. That is the opposite of what
 * this function used to do, and the reasoning it replaces was sound in theory
 * and wrong in practice, so it is worth writing down which measurement settled
 * it. The old version walked the primary key with a cursor, on the grounds that
 * an unindexed search for scattered nulls degrades to a full scan. True — but
 * the walk had two costs the argument missed: it reads and discards the ~99% of
 * rows that are *already* keyed, and the cursor is held in memory, so **every
 * deploy restarts it at the beginning of a 1.75M-row table**. On production it
 * had been running for a day, logging `keyed=0` on every pass, and had reached
 * nothing — while 15,821 unkeyed rows sat there waiting.
 *
 * Measured against that table: a direct `where cluster_key is null limit 500`
 * takes ~20 seconds and comes back with 500 rows that all need work. The whole
 * remaining backfill is 32 such passes, about eleven minutes, after which the
 * query returns nothing and the caller latches off for good. The cursor walk's
 * predictable number of reads was ~3,500 passes, none of which did anything,
 * repeated from scratch on every deploy.
 *
 * The tail is the case the old comment was right about: the last few passes
 * scan most of the table to find the last few rows. That is a handful of
 * ~14-second reads, once, at the end of a backfill that then never runs again.
 *
 * @param {Client} db
 * @param {number} [limit] rows per pass
 * @returns {Promise<{ scanned: number, keyed: number, done: boolean }>}
 *   `done` is true once no unkeyed row remains anywhere in the table.
 */
export async function backfillClusterKeys(db, limit = 500) {
  const { rows } = await db.execute({
    sql: `select id, title from feed_items where cluster_key is null limit ?`,
    args: [limit],
  });

  // Nothing left anywhere in the table. The caller latches off for the life of
  // the process on this, and it is now a claim the query can actually make:
  // the old cursor walk could only ever say "nothing in *this page*".
  if (rows.length === 0) return { scanned: 0, keyed: 0, done: true };

  let keyed = 0;
  const statements = rows.map((row) => {
    const key = clusterKey(String(row.title ?? '')) ?? '';
    if (key) keyed += 1;
    return {
      sql: `update feed_items set cluster_key = ? where id = ?`,
      args: [key, row.id],
    };
  });

  await db.batch(statements, 'write');
  return { scanned: rows.length, keyed, done: false };
}

/**
 * @param {Client} db
 * @param {string} feedId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function itemsForFeed(db, feedId, limit = 50) {
  const { rows } = await db.execute({
    sql: `select id, guid, url, title, summary, author, image_url, published_at,
                 audio_url, audio_type, audio_seconds
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
    sql: `select id, guid, url, title, summary, author, image_url, published_at,
                 audio_url, audio_type, audio_seconds
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

// ------------------------------------------------------------------- topics

/**
 * The text a feed's topics are extracted from.
 *
 * Titles and summaries only: they are the feed's own prose with the markup
 * already stripped, and content_html is the same words again wrapped in tags
 * that would have to be stripped a second time to say anything new.
 *
 * Capped, because a feed's topics are what it is about lately — an archive of
 * four thousand posts would otherwise be re-tokenized on every crawl to
 * rediscover the same subjects.
 *
 * @param {Client} db
 * @param {string} feedId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function itemsForKeywords(db, feedId, limit = 200) {
  const { rows } = await db.execute({
    sql: `select title, summary, categories from feed_items
          where feed_id = ?
          order by published_at desc nulls last, created_at desc
          limit ?`,
    args: [feedId, limit],
  });
  return rows;
}

/**
 * Replace a feed's topics with a freshly extracted set.
 *
 * Delete-then-insert rather than an upsert: keywords are derived from the
 * feed's current text, so a topic the feed has stopped writing about has to
 * disappear, and an upsert would leave it behind forever.
 *
 * @param {Client} db
 * @param {string} feedId
 * @param {Array<{ slug: string, keyword: string, words: number, count: number, source: string }>} keywords
 * @returns {Promise<number>} rows written
 */
export async function replaceFeedKeywords(db, feedId, keywords) {
  // One batch, so a feed is never left with its old topics deleted and its new
  // ones unwritten.
  await db.batch(keywordStatements(feedId, keywords), 'write');
  return keywords.length;
}

/**
 * A feed's topics as statements, ready to join somebody else's transaction.
 *
 * Split out so that `crawlFeed` can put the items, the feed row, the topics and
 * the credits into a **single** write transaction. On this database writes
 * serialize -- SQLite has one writer -- so the cost of a crawl is very nearly
 * the number of transactions it opens, not the work inside them. Folding three
 * transactions into one is a threefold change in crawl throughput; making any
 * one of them cheaper is not.
 *
 * @param {string} feedId
 * @param {Array<{ slug: string, keyword: string, words?: number, count?: number, source?: string }>} keywords
 * @returns {Array<{ sql: string, args: unknown[] }>}
 */
export function keywordStatements(feedId, keywords) {
  return [
    { sql: 'delete from feed_keywords where feed_id = ?', args: [feedId] },
    ...(keywords ?? []).map((k) => ({
      sql: `insert into feed_keywords (feed_id, slug, keyword, words, count, source)
            values (?, ?, ?, ?, ?, ?)
            on conflict (feed_id, slug) do nothing`,
      args: [feedId, k.slug, k.keyword, k.words ?? 1, k.count ?? 0, k.source ?? 'content'],
    })),
  ];
}

/**
 * How many topics a feed has — the cheap "has this ever been extracted?" test.
 *
 * @param {Client} db
 * @param {string} feedId
 * @returns {Promise<number>}
 */
export async function countFeedKeywords(db, feedId) {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from feed_keywords where feed_id = ?',
    args: [feedId],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * A feed's own topics, for its page.
 *
 * @param {Client} db
 * @param {string} feedId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function keywordsForFeed(db, feedId, limit = 12) {
  const { rows } = await db.execute({
    sql: `select slug, keyword, words, count, source from feed_keywords
          where feed_id = ?
          order by case source when 'category' then 0 else 1 end, count desc, keyword asc
          limit ?`,
    args: [feedId, limit],
  });
  return rows;
}

/**
 * How many feeds carry a topic, and what it is called.
 *
 * Read from feed_keywords rather than the topics rollup so a topic page is
 * never stale, and so a topic that appeared since the last refresh still has a
 * working page.
 *
 * @param {Client} db
 * @param {string} slug
 * @returns {Promise<{ slug: string, keyword: string, feedCount: number }|null>}
 */
export async function topicBySlug(db, slug) {
  const { rows } = await db.execute({
    sql: `select k.slug,
                 -- Any spelling will do as the display name: extraction
                 -- lowercases its keywords and categories are lowercased before
                 -- they are stored, so the rows under one slug differ only in
                 -- ways the slug already erased. Same rule as the rollup, so
                 -- the index and the page always agree on the title.
                 min(k.keyword) as keyword,
                 count(*) as feed_count
          from feed_keywords k
          join feeds f on f.id = k.feed_id and f.status <> 'dead'
          where k.slug = ?
          group by k.slug`,
    args: [slug],
  });

  const row = rows[0];
  if (!row) return null;
  return {
    slug: String(row.slug),
    keyword: String(row.keyword ?? row.slug),
    feedCount: Number(row.feed_count ?? 0),
  };
}

/**
 * The feeds filed under one topic, strongest first.
 *
 * A feed's own categories rank above a keyword counted out of its prose: the
 * publisher saying "this is about homelabs" outranks us noticing the word.
 *
 * `kinds` narrows it to a sub-group of the topic — the blogs about physics
 * rather than everything about physics. See `normalizeKinds`.
 *
 * @param {Client} db
 * @param {string} slug
 * @param {{ limit?: number, offset?: number, kinds?: string[]|null }} [opts]
 * @returns {Promise<object[]>}
 */
export async function feedsForTopic(db, slug, opts = {}) {
  const { limit = 60, offset = 0, kinds = null } = opts;
  const filter = kindFilter(normalizeKinds(kinds));

  const { rows } = await db.execute({
    sql: `select f.slug, f.title, f.description, f.site_url, f.feed_url, f.category, f.item_count,
                 f.image_url, f.card_url, k.keyword, k.count, k.source
          from feed_keywords k
          join feeds f on f.id = k.feed_id
          where k.slug = ? and f.status <> 'dead'${filter.sql}
          order by case k.source when 'category' then 0 else 1 end, k.count desc, f.title asc
          limit ? offset ?`,
    args: [slug, ...filter.args, limit, offset],
  });
  return rows;
}

/**
 * How many feeds a topic has of each category.
 *
 * One query for the whole breakdown rather than one per sub-group: the topic
 * page links every group that has anything in it, so the alternative is eight
 * counts on a page that already runs a listing query.
 *
 * Categories with nothing in them are absent rather than zero, which is what
 * the page wants — a link to an empty sub-group is a link to a page that says
 * "nothing here".
 *
 * @param {Client} db
 * @param {string} slug
 * @returns {Promise<Record<string, number>>}
 */
export async function topicKindCounts(db, slug) {
  const { rows } = await db.execute({
    sql: `select f.category, count(*) as n
          from feed_keywords k
          join feeds f on f.id = k.feed_id and f.status <> 'dead'
          where k.slug = ?
          group by f.category`,
    args: [slug],
  });

  /** @type {Record<string, number>} */
  const counts = {};
  for (const row of rows) counts[String(row.category)] = Number(row.n ?? 0);
  return counts;
}

/**
 * How many of a topic's feeds a river is allowed to draw from.
 *
 * This is a latency budget, not a taste judgement, and it is the single number
 * that decides whether a topic feed answers. Measured against production:
 * `physics` carries 128 feeds and `ai` carries 5,426, and the honest query —
 * every item from every feed on the topic, newest first — takes **274 seconds**
 * on the large one. Capped to the 200 strongest feeds and bounded by a date it
 * answers in about 100ms, on the same data, for topics of every size.
 *
 * The feeds that get cut are the weakest matches: a blog that mentioned the
 * word twice, not one that is filed under it. Ordering is the same as the topic
 * page's, so the river is drawn from the feeds at the top of that page.
 */
const TOPIC_RIVER_FEEDS = 200;

/**
 * How far back a topic river looks.
 *
 * A river is what a topic is publishing, so a window is the right shape and not
 * only a cheap one — but it is also load-bearing for the query plan. Bounding
 * `published_at` lets SQLite seek into `feed_items_feed_pub_idx` per feed
 * instead of reading every item those feeds ever published and sorting the
 * pile, which is the difference between 100ms and ten seconds.
 *
 * Two years rather than two months: the directory holds a great many blogs that
 * post twice a year, and a topic that returned nothing because its writers are
 * unhurried would read as broken.
 */
const TOPIC_RIVER_DAYS = 730;

/**
 * Recent posts from across a topic, newest first.
 *
 * This is the topic as a *river* — what the feeds filed under it have published
 * — which is a different question from `feedsForTopic`, the directory listing of
 * who those feeds are. The syndication endpoints are built on this one; the
 * topic page is built on the other.
 *
 * Rows carry their publication (`feed_title`, `feed_slug`, `feed_url`) because
 * every consumer needs it: RSS puts it in `<source>`, a playlist puts it in the
 * entry title, and a reader shown sixty posts from a hundred blogs cannot tell
 * who wrote what without it.
 *
 * @param {Client} db
 * @param {string} slug
 * @param {{
 *   limit?: number,
 *   feedCap?: number,
 *   days?: number,
 *   kinds?: string[]|null,
 *   group?: boolean,
 * }} [opts] `kinds` narrows the river to feeds of those categories; `group`
 *   collapses the same story told by several of them, which costs an overread
 *   and is why the SQL limit is `want` rather than `limit`.
 * @returns {Promise<object[]>}
 */
export async function itemsForTopic(db, slug, opts = {}) {
  const {
    limit = 50,
    feedCap = TOPIC_RIVER_FEEDS,
    days = TOPIC_RIVER_DAYS,
    kinds = null,
    group = true,
  } = opts;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  // Applied inside `picked`, so the cap counts feeds of the requested kinds
  // rather than spending itself on the ones about to be filtered out. A river
  // of a topic's podcasts would otherwise be drawn from whichever podcasts
  // happened to survive a cut made mostly of blogs.
  const filter = kindFilter(normalizeKinds(kinds));

  // Grouping removes rows, so the query has to read past `limit` to still fill
  // a page after the duplicates collapse. Three times over is enough for the
  // observed shape — a story rarely runs in more than a handful of the feeds on
  // one topic — and it is bounded, which a "keep reading until full" loop is
  // not. Collapsing in JS rather than SQL is deliberate: the river's join is
  // already the expensive part, and a correlated subquery to pick one row per
  // key would be run over every row it returns.
  const want = group ? Math.min(limit * 3, 600) : limit;

  const { rows } = await db.execute({
    sql: `with picked as (
            select k.feed_id from feed_keywords k
            join feeds f on f.id = k.feed_id and f.status <> 'dead'
            where k.slug = ?${filter.sql}
            order by case k.source when 'category' then 0 else 1 end, k.count desc
            limit ?
          )
          select i.guid, i.url, i.title, i.summary, i.author, i.image_url, i.published_at,
                 i.audio_url, i.audio_type, i.audio_bytes, i.audio_seconds, i.cluster_key,
                 f.slug as feed_slug, f.title as feed_title, f.feed_url, f.category,
                 -- The feed's own cover art, as the fallback thumbnail for a
                 -- post that has none of its own. A podcast's episode without
                 -- its own art is meant to show the show's, and a river of
                 -- mixed feeds reads better as a column of pictures than as a
                 -- column with gaps in it.
                 f.image_url as feed_image, f.card_url as feed_card
          from feed_items i
          join feeds f on f.id = i.feed_id
          where i.feed_id in (select feed_id from picked)
            and i.published_at >= ?
          order by i.published_at desc
          limit ?`,
    // `filter.args` belongs to the `picked` subquery and `want` to the outer
    // limit, so the kind filter and the grouping overread bind in the order
    // their placeholders appear rather than one replacing the other.
    args: [slug, ...filter.args, feedCap, since, want],
  });

  if (!group) return rows;

  // Ordered newest-first above, and dedupeItems keeps the first occurrence, so
  // the telling that survives is the one that ran first.
  return dedupeItems(rows).slice(0, limit);
}

/**
 * The playable media a topic has, newest first.
 *
 * Separate from itemsForTopic rather than a filter on it, for one reason that
 * only shows up in the playlist formats: an item parsed out of an `.m3u` or a
 * radio `.pls` has **no published date at all** — the format has no field for
 * one — so the river's date window, which is what makes it fast, excludes
 * exactly the entries a playlist most wants. This orders `nulls last` and takes
 * the date filter off, and pays for it by filtering on `audio_url` instead,
 * which cuts the row count enough to stay inside a couple of seconds.
 *
 * @param {Client} db
 * @param {string} slug
 * @param {{ limit?: number, feedCap?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function mediaForTopic(db, slug, opts = {}) {
  const { limit = 100, feedCap = TOPIC_RIVER_FEEDS, kinds = null } = opts;
  const filter = kindFilter(normalizeKinds(kinds));

  const { rows } = await db.execute({
    sql: `with picked as (
            select k.feed_id from feed_keywords k
            join feeds f on f.id = k.feed_id and f.status <> 'dead'
            where k.slug = ?${filter.sql}
            order by case k.source when 'category' then 0 else 1 end, k.count desc
            limit ?
          )
          select i.id as item_id, i.guid, i.url, i.title, i.summary, i.author, i.image_url,
                 i.published_at,
                 i.audio_url, i.audio_type, i.audio_bytes, i.audio_seconds,
                 f.slug as feed_slug, f.title as feed_title, f.feed_url, f.category
          from feed_items i
          join feeds f on f.id = i.feed_id
          where i.feed_id in (select feed_id from picked)
            and i.audio_url is not null
          order by i.published_at desc nulls last, i.created_at desc
          limit ?`,
    args: [slug, ...filter.args, feedCap, limit],
  });
  return rows;
}

/**
 * A search term, as a LIKE pattern that cannot smuggle in a wildcard.
 *
 * `%` and `_` are LIKE's own metacharacters, so a user searching for "100_days"
 * would otherwise match anything with "100" and any character before "days".
 * The backslash is declared with `escape` at each call site.
 *
 * @param {string} term
 * @returns {string}
 */
function likeTerm(term) {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A search term as the index stores it.
 *
 * The topics index is a table of slugs, so a search for "quantum physics"
 * matched nothing while "quantum-physics" matched — which asked the caller to
 * know the slugging rules before they could ask a question. Running the term
 * through the same function that minted the slugs makes the two spellings one
 * search, and it is the same normalisation every single-topic route already
 * does to the keyword in its URL.
 *
 * A term that slugs to nothing — punctuation only — keeps its raw form rather
 * than becoming the empty string, so it searches and finds nothing instead of
 * silently turning into "list everything".
 *
 * @param {string|null} query
 * @returns {string}
 */
function searchSlug(query) {
  const raw = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!raw) return '';
  return topicSlug(raw) || raw;
}

/**
 * The topics index, from the rollup, optionally searched.
 *
 * `query` is ranked rather than filtered: exact slug first, then slugs that
 * start with the term, then slugs that merely contain it, each tier by feed
 * count. Prefix-only matching hides `myhomelab` from a search for "homelab",
 * and contains-only matching answers "rust" with "trustworthy" ahead of the
 * language — ranking is what gets both right, and the caller can stop reading
 * as soon as the results stop looking relevant.
 *
 * @param {Client} db
 * @param {{ limit?: number, offset?: number, minFeeds?: number, query?: string|null }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listTopics(db, opts = {}) {
  const { limit = 200, offset = 0, minFeeds = 2, query = null } = opts;
  const term = searchSlug(query);

  if (!term) {
    const { rows } = await db.execute({
      sql: `select slug, keyword, feed_count from topics
            where feed_count >= ?
            order by feed_count desc, slug asc
            limit ? offset ?`,
      args: [minFeeds, limit, offset],
    });
    return rows;
  }

  const escaped = likeTerm(term);
  const { rows } = await db.execute({
    sql: `select slug, keyword, feed_count from topics
          where feed_count >= ? and slug like ? escape '\\'
          order by case when slug = ? then 0
                        when slug like ? escape '\\' then 1
                        else 2 end,
                   feed_count desc, slug asc
          limit ? offset ?`,
    args: [minFeeds, `%${escaped}%`, term, `${escaped}%`, limit, offset],
  });
  return rows;
}

/**
 * @param {Client} db
 * @param {number} [minFeeds]
 * @param {string|null} [query] the same term {@link listTopics} was given
 * @returns {Promise<number>}
 */
export async function countTopics(db, minFeeds = 2, query = null) {
  const term = searchSlug(query);

  if (!term) {
    const { rows } = await db.execute({
      sql: 'select count(*) as n from topics where feed_count >= ?',
      args: [minFeeds],
    });
    return Number(rows[0]?.n ?? 0);
  }

  const { rows } = await db.execute({
    sql: `select count(*) as n from topics where feed_count >= ? and slug like ? escape '\\'`,
    args: [minFeeds, `%${likeTerm(term)}%`],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Rebuild the topics rollup.
 *
 * The whole table is rewritten rather than diffed. It is a projection of
 * feed_keywords with nothing in it that cannot be recomputed, and a delete plus
 * an insert-select is one round trip that always lands on the right answer —
 * where an incremental refresh has to be right every time forever to avoid
 * drifting into counts nobody can explain.
 *
 * Topics carried by a single feed are left out: they are the long tail of one
 * blog's vocabulary, they are the overwhelming majority of the rows, and a page
 * listing one feed is not a topic page.
 *
 * @param {Client} db
 * @param {number} [minFeeds]
 * @returns {Promise<number>} topics in the rollup
 */
export async function refreshTopics(db, minFeeds = 2) {
  const now = nowIso();

  await db.batch(
    [
      { sql: 'delete from topics', args: [] },
      {
        sql: `insert into topics (slug, keyword, feed_count, refreshed_at)
              select k.slug,
                     min(k.keyword),
                     count(distinct k.feed_id),
                     ?
              from feed_keywords k
              join feeds f on f.id = k.feed_id and f.status <> 'dead'
              group by k.slug
              having count(distinct k.feed_id) >= ?`,
        args: [now, minFeeds],
      },
    ],
    'write',
  );

  const { rows } = await db.execute('select count(*) as n from topics');
  return Number(rows[0]?.n ?? 0);
}

/**
 * Topics whose pages the sitemap should list.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function topicsForSitemap(db, limit = 20_000) {
  const { rows } = await db.execute({
    sql: 'select slug, refreshed_at from topics order by feed_count desc, slug asc limit ?',
    args: [limit],
  });
  return rows;
}

/**
 * The backlog each kind of work is sitting on, for the jobs board.
 *
 * One pass over `feeds` for all of it, for the same reason `crawlStats` is one
 * pass: /crawlstats is public, uncached and refreshes itself every fifteen
 * seconds, so every figure it shows has to be affordable at that rate forever.
 *
 * The counts are deliberately per *job* rather than per feed status, because
 * they answer different questions. `due` is the update queue — feeds already
 * indexed whose next check has come round — and it is permanently large by
 * design: 52,000 feeds on an hourly interval want more checks per hour than any
 * polite crawler will make. `neverCrawled` is the queue that should be near
 * empty, and is the one worth an alarm when it is not, because those are
 * submissions nobody has seen the result of yet.
 *
 * @param {Client} db
 * @returns {Promise<object>}
 */
export async function jobBacklogs(db) {
  const now = nowIso();
  const hourAgo = nowIso(-3_600_000);

  // Nine conditional aggregates over all 368k feed rows, exactly as `crawlStats`
  // used to be, and slow for exactly the same reason: to evaluate a CASE the
  // planner has to visit the row, so the statement dragged the whole of a 14 GB
  // table through memory. Measured at 3,713ms, on a page that refreshes itself
  // every fifteen seconds.
  //
  // The fix is not "stop using conditional aggregates" — two of them survive
  // below. It is to make sure the scan they force is over a *covering index*
  // rather than over the table, at which point the same CASE is cheap.
  const [byStatus, backlog, submitted, cards, enriched] = await Promise.all([
    // One covering scan of feeds_status_success_idx (0028) answering three
    // questions at once: the status breakdown, and how many feeds in each state
    // have never once been read successfully.
    db.execute(`select status, count(*) as n,
                       sum(case when last_success_at is null then 1 else 0 end) as never
                from feeds group by status`),

    // The backlog by its complement — see `crawlStats` and `countDueFeeds`.
    db.execute({
      sql: `select count(*) as n from feeds where status <> 'dead' and next_fetch_at > ?`,
      args: [now],
    }),

    // A short range read off feeds_created_idx: an hour of submissions is a
    // handful of rows however large the directory gets.
    db.execute({
      sql: `select count(*) as n from feeds where created_at >= ? and status = 'pending'`,
      args: [hourAgo],
    }),

    // One covering scan of feeds_card_state_idx (0029).
    db.execute({
      sql: `select card_state, count(*) as n,
                   sum(case when card_checked_at >= ? then 1 else 0 end) as hour
            from feeds group by card_state`,
      args: [hourAgo],
    }),

    // How far the author enrichment has walked, read off the partial index
    // 0024 already built for it (`feeds (authors_checked_at) where status =
    // 'active'`). Counted as the *stamped* set rather than the unstamped one
    // for the reason this whole function exists: 3,275 of 369,056 feeds carry a
    // stamp, so this touches a few thousand index entries, while asking for the
    // complement would visit every row. The backlog is arithmetic afterwards.
    db.execute({
      sql: `select count(*) as n,
                   sum(case when authors_checked_at >= ? then 1 else 0 end) as hour
            from feeds
           where status = 'active' and authors_checked_at is not null`,
      args: [hourAgo],
    }),
  ]);

  // Deliberately no "first crawls completed this hour". Nothing records when a
  // feed was read for the *first* time, and every way of inferring it from
  // these columns is a guess — a status board that mixes measurements with
  // guesses is worse than one that admits the gap. The first-crawl row shows
  // its backlog and its inflow, and says outright that it shares the update
  // queue's throughput.
  const states = new Map(byStatus.rows.map((r) => [String(r.status), r]));
  const n = (status) => Number(states.get(status)?.n ?? 0);

  const total = [...states.values()].reduce((a, r) => a + Number(r.n ?? 0), 0);
  // Attempted and never once successful, across everything not given up on. A
  // wider set than the first-crawl queue, and deliberately not the same: a feed
  // that has failed nine times is not waiting for its first crawl, it is
  // failing, and the page counts it under Erroring.
  const neverCrawled = [...states.entries()]
    .filter(([status]) => status !== 'dead')
    .reduce((a, [, r]) => a + Number(r.never ?? 0), 0);

  const byCard = new Map(cards.rows.map((r) => [r.card_state === null ? null : String(r.card_state), r]));
  const card = (state) => Number(byCard.get(state)?.n ?? 0);

  return {
    due: Math.max(0, total - n('dead') - Number(backlog.rows[0]?.n ?? 0)),
    pendingFirstCrawl: n('pending'),
    neverCrawled,
    submittedLastHour: Number(submitted.rows[0]?.n ?? 0),
    cardsPending: card(null),
    cardsOk: card('ok'),
    cardsNone: card('none'),
    cardsError: card('error'),
    cardsLastHour: cards.rows.reduce((a, r) => a + Number(r.hour ?? 0), 0),
    authorsDone: Number(enriched.rows[0]?.n ?? 0),
    authorsPending: Math.max(0, n('active') - Number(enriched.rows[0]?.n ?? 0)),
    authorsLastHour: Number(enriched.rows[0]?.hour ?? 0),
  };
}

/**
 * What each kind of work has been doing lately, from the log it already writes.
 *
 * The poller names every line by event — 'feed', 'crawl', 'cards',
 * 'discovery-search', 'cluster-backfill' — so grouping the log by that column is
 * a per-job activity feed with no new bookkeeping and nothing for a metrics
 * table to drift away from. It answers the question a backlog cannot: a queue
 * that is large and moving and a queue that is large and stopped look identical
 * in a count.
 *
 * Bounded by `at`, which is the one index this table has, and returned as a map
 * so a caller reads it by event name rather than searching an array.
 *
 * @param {Client} db
 * @param {number} [hours]
 * @returns {Promise<Record<string, { lines: number, errors: number, amount: number, lastAt: string|null, ms: number|null }>>}
 */
export async function logActivity(db, hours = 1) {
  const since = nowIso(-Math.max(1, hours) * 3_600_000);

  const { rows } = await db.execute({
    sql: `select event,
                 count(*)                                              as lines,
                 sum(case when status = 'error' then 1 else 0 end)      as errors,
                 coalesce(sum(amount), 0)                              as amount,
                 -- The poller's own count for the event, whatever that event
                 -- calls it. Most summary lines put their number inside detail
                 -- rather than in the amount column, which is how a board built on
                 -- amount alone came to report a busy discovery worker as stalled:
                 -- it had checked 700 sites and reported 0.
                 --
                 -- Guarded on the leading brace because detail is either a JSON
                 -- object or a plain error message, and json_extract raises on the
                 -- second rather than returning null.
                 coalesce(sum(case when detail like '{%' then coalesce(
                   json_extract(detail, '$.checked'),
                   json_extract(detail, '$.searched'),
                   json_extract(detail, '$.keyed'),
                   json_extract(detail, '$.looked'),
                   json_extract(detail, '$.crawled'),
                   json_extract(detail, '$.topics'),
                   json_extract(detail, '$.sent'),
                   json_extract(detail, '$.rows')
                 ) end), 0)                                            as counted,
                 max(at)                                               as last_at,
                 -- The typical cost of one pass, not the total: a job that has
                 -- run twice in an hour and a job that has run 200 times are
                 -- not comparable on a sum.
                 cast(avg(ms) as integer)                              as ms
          from crawl_log
          where at >= ?
          group by event`,
    args: [since],
  });

  /** @type {Record<string, { lines: number, errors: number, amount: number, lastAt: string|null, ms: number|null }>} */
  const byEvent = {};
  for (const row of rows) {
    byEvent[String(row.event)] = {
      lines: Number(row.lines ?? 0),
      errors: Number(row.errors ?? 0),
      // The column where it exists, the payload where it does not, so a job's
      // rate does not depend on which of the two the poller happened to use.
      amount: Number(row.amount ?? 0) || Number(row.counted ?? 0),
      lastAt: row.last_at ? String(row.last_at) : null,
      ms: row.ms == null ? null : Number(row.ms),
    };
  }

  return byEvent;
}

/**
 * A snapshot of what the crawler is doing, for /crawlstats.
 *
 * This used to be one statement, and one statement was the wrong shape. It read
 * `select count(*), sum(case when ...) ... from feeds` with twelve conditional
 * aggregates, and a conditional aggregate cannot use an index: SQLite has to
 * visit every row to evaluate the CASE. At 368k feeds that measured **20.2
 * seconds** against production, which was the entirety of the page's fifteen
 * second time to first byte. The comment it replaces claimed the cost stayed
 * flat as the directory grew; it grew linearly with it, and nobody noticed
 * until the directory got eight times bigger in two days.
 *
 * It is now four reads, none of which touches more rows than it reports on:
 *
 *   1. **the status breakdown**, as a plain `group by status` -- one grouped
 *      walk of `feeds_status_idx` instead of five separate CASE scans;
 *   2. **the backlog**, counted by its complement. `due` is 367k of 368k rows,
 *      so counting the feeds that are due costs a walk of nearly the whole
 *      index (4.8s measured) while counting the ~1.2k that are *not* due is a
 *      short range read. The answer is identical arithmetic;
 *   3. **liveness and staleness**, both served by `feeds_status_success_idx`
 *      (0028) as index seeks rather than 62k row lookups;
 *   4. **throughput**, from the `crawl_hourly` rollup rather than from `feeds`.
 *
 * That last one is the change worth knowing about, because it is a change of
 * *definition* and not just of cost. "Fetched in the last day" used to mean
 * "distinct feeds whose last_fetched_at falls in the window" -- which quietly
 * caps at the size of the directory and cannot see a feed crawled twice. It now
 * means "crawls the poller performed", which is what the label on the page
 * ("crawler throughput") has always claimed and what the rollup was built in
 * 0017 to record. Expect the 24h numbers to read *higher* than they did, and to
 * keep rising past `active` where the old ones could not.
 *
 * The hour figure is a **rate**, derived from the last two hourly buckets over
 * the span they actually cover, rather than a count of the current bucket. A
 * bucket-count would read zero for the first minutes of every hour, and
 * `fetchedLastHour === 0` is what the page's health badge treats as "stalled" --
 * an hourly false alarm is worse than an estimate.
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
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

  const [statuses, backlog, liveness, throughput] = await Promise.all([
    // One grouped walk of feeds_status_idx. Statuses the directory does not
    // currently contain simply do not come back as rows, which is why each is
    // read out of the map with a zero default below rather than positionally.
    db.execute('select status, count(*) as n from feeds group by status'),

    // The complement of the backlog: feeds that are *not* yet due. See the note
    // above -- this is a short read where counting the backlog directly is very
    // nearly a full index walk.
    db.execute({
      sql: `select count(*) as n from feeds where status <> 'dead' and next_fetch_at > ?`,
      args: [now],
    }),

    // Both halves of the health badge, off feeds_status_success_idx.
    //
    // `min(next_fetch_at)` rides along here rather than in its own read: it is
    // served by feeds_due_idx, the partial index on the same `status <> 'dead'`
    // predicate, so it is a single seek to the front of it.
    db.execute({
      sql: `select
              (select max(last_success_at) from feeds where status = 'active') as last_success_at,
              (select count(*) from feeds
                where status = 'active' and (last_success_at is null or last_success_at < ?)) as stale,
              (select min(next_fetch_at) from feeds where status <> 'dead') as next_fetch_at`,
      args: [dayAgo],
    }),

    // 25 buckets rather than 24: the day window opens inside the oldest one, and
    // the rate calculation below needs the two most recent buckets present.
    db.execute({
      sql: `select hour, fetched, succeeded, items from crawl_hourly
            where hour >= ? order by hour desc limit 25`,
      args: [new Date(Date.now() - 25 * 3_600_000).toISOString().slice(0, 13)],
    }),
  ]);

  const byStatus = new Map(statuses.rows.map((r) => [String(r.status), Number(r.n ?? 0)]));
  const count = (status) => byStatus.get(status) ?? 0;
  const total = [...byStatus.values()].reduce((a, b) => a + b, 0);
  const dead = count('dead');

  // Everything alive, minus everything alive that is still waiting its turn.
  const notDue = Number(backlog.rows[0]?.n ?? 0);
  const live = liveness.rows[0] ?? {};

  const hours = throughput.rows;
  const day = hours.slice(0, 24);
  const sum = (rows, key) => rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);

  // The last two buckets span somewhere between one and two hours of real time
  // depending on where in the current hour we are, so the rate is the work they
  // recorded over the span they actually cover -- not over a nominal two hours,
  // which would halve the reported rate at the top of every hour.
  const recent = hours.slice(0, 2);
  const minutesIntoHour = new Date().getUTCMinutes();
  const spanHours = recent.length === 0 ? 0 : recent.length === 1 ? 1 : 1 + minutesIntoHour / 60;

  const lastSuccessAt = live.last_success_at ? String(live.last_success_at) : null;

  return {
    total,
    active: count('active'),
    pending: count('pending'),
    errored: count('error'),
    dead,
    due: Math.max(0, total - dead - notDue),
    fetchedLastHour: spanHours > 0 ? Math.round(sum(recent, 'fetched') / spanHours) : 0,
    fetchedLastDay: sum(day, 'fetched'),
    succeededLastDay: sum(day, 'succeeded'),
    staleActive: Number(live.stale ?? 0),
    itemsLastDay: sum(day, 'items'),
    lastSuccessAt,
    // Minutes since the crawler last read *anything* successfully, and the
    // signal the health badge is built on. Null only when the directory has
    // never had a successful crawl at all.
    //
    // It is deliberately not derived from the throughput figures above. Those
    // now come from `crawl_hourly`, and the poller writes that rollup inside a
    // try/catch that treats a failure as "housekeeping lost, not a crawl lost"
    // — so a page that inferred "stalled" from a throughput of zero would
    // report an outage every time a rollup write failed, while the crawler was
    // working perfectly. This number comes off `feeds` itself, by way of the
    // same index seek that produced `lastSuccessAt`, so it cannot disagree with
    // what the crawler actually did.
    idleMinutes: lastSuccessAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(lastSuccessAt)) / 60_000))
      : null,
    nextFetchAt: live.next_fetch_at ? String(live.next_fetch_at) : null,
    generatedAt: now,
  };
}

/**
 * Add one poller tick's work to the hour it happened in.
 *
 * Called once per tick rather than once per feed: a tick is already a batch,
 * and an upsert per crawled feed would be twenty-five extra writes a minute to
 * arrive at the same five numbers.
 *
 * `ticks` counts reports rather than feeds so a reader of the table can tell a
 * live-recorded hour from one backfilled by 0017 — see the column's comment
 * there. An hour the crawler genuinely sat out still gets a row, because a tick
 * that crawled nothing calls this too.
 *
 * @param {Client} db
 * @param {{ fetched?: number, succeeded?: number, failed?: number, items?: number }} counts
 * @param {string} [at] ISO timestamp deciding the bucket; defaults to now
 * @returns {Promise<void>}
 */
export async function recordCrawlHour(db, counts, at = nowIso()) {
  const hour = at.slice(0, 13);

  await db.execute({
    sql: `insert into crawl_hourly (hour, ticks, fetched, succeeded, failed, items)
          values (?, 1, ?, ?, ?, ?)
          on conflict (hour) do update set
            ticks     = crawl_hourly.ticks + 1,
            fetched   = crawl_hourly.fetched + excluded.fetched,
            succeeded = crawl_hourly.succeeded + excluded.succeeded,
            failed    = crawl_hourly.failed + excluded.failed,
            items     = crawl_hourly.items + excluded.items`,
    args: [
      hour,
      Number(counts.fetched ?? 0),
      Number(counts.succeeded ?? 0),
      Number(counts.failed ?? 0),
      Number(counts.items ?? 0),
    ],
  });
}

/**
 * Write down how much work is waiting, into this hour's bucket.
 *
 * Overwrites rather than accumulating, and that is the whole difference between
 * this and `recordCrawlHour`: these are gauges. Two samples in one hour are not
 * two hundred waiting feeds plus two hundred more, they are the same queue
 * looked at twice, and the later look is the one worth keeping.
 *
 * @param {Client} db
 * @param {{ due?: number, firstCrawl?: number, cards?: number, authors?: number }} depths
 * @param {string} [at] ISO timestamp deciding the bucket; defaults to now
 * @returns {Promise<void>}
 */
export async function recordQueueHour(db, depths, at = nowIso()) {
  await db.execute({
    sql: `insert into queue_hourly (hour, at, due, first_crawl, cards, authors)
          values (?, ?, ?, ?, ?, ?)
          on conflict (hour) do update set
            at          = excluded.at,
            due         = excluded.due,
            first_crawl = excluded.first_crawl,
            cards       = excluded.cards,
            authors     = excluded.authors`,
    args: [
      at.slice(0, 13),
      at,
      Number(depths.due ?? 0),
      Number(depths.firstCrawl ?? 0),
      Number(depths.cards ?? 0),
      Number(depths.authors ?? 0),
    ],
  });
}

/**
 * How many feeds have never been looked at for an author.
 *
 * Counted by its complement, because the set is very nearly the whole directory
 * — 367,518 of 369,054 when this was written — and counting a near-total set
 * directly means visiting almost every row. The checked side is small and sits
 * on the partial index 0024 added, so both halves are cheap.
 *
 * @param {Client} db
 * @returns {Promise<number>}
 */
export async function countAuthorQueue(db) {
  const [active, checked] = await Promise.all([
    db.execute(`select count(*) as n from feeds where status = 'active'`),
    db.execute(
      `select count(*) as n from feeds where status = 'active' and authors_checked_at is not null`,
    ),
  ]);

  return Math.max(0, Number(active.rows[0]?.n ?? 0) - Number(checked.rows[0]?.n ?? 0));
}

/**
 * Drop queue samples older than the charts can show.
 *
 * @param {Client} db
 * @param {number} [days]
 * @returns {Promise<number>} rows removed
 */
export async function pruneQueueHours(db, days = 90) {
  const { rowsAffected } = await db.execute({
    sql: 'delete from queue_hourly where hour < ?',
    args: [nowIso(-days * 86_400_000).slice(0, 13)],
  });
  return Number(rowsAffected ?? 0);
}

/**
 * Every queue's depth hour by hour, ready to plot.
 *
 * Sparse on purpose, unlike the throughput series. A missing hour here means
 * nobody took a sample, and a burndown that interpolates across an outage
 * invents a descent that never happened — so the gap is returned as a gap and
 * the chart draws it as one.
 *
 * @param {Client} db
 * @param {number} [hours]
 * @returns {Promise<Array<{ hour: string, at: string, due: number, firstCrawl: number, cards: number, authors: number }>>}
 */
export async function queueHistory(db, hours = 48) {
  const { rows } = await db.execute({
    sql: `select hour, at, due, first_crawl, cards, authors
            from queue_hourly
           where hour >= ?
           order by hour asc`,
    args: [nowIso(-hours * 3_600_000).slice(0, 13)],
  });

  return rows.map((r) => ({
    hour: String(r.hour),
    at: String(r.at),
    due: Number(r.due ?? 0),
    firstCrawl: Number(r.first_crawl ?? 0),
    cards: Number(r.cards ?? 0),
    authors: Number(r.authors ?? 0),
  }));
}

/**
 * Drop rollup rows older than the charts can show.
 *
 * @param {Client} db
 * @param {number} [days]
 * @returns {Promise<number>} rows removed
 */
export async function pruneCrawlHours(db, days = 90) {
  const { rowsAffected } = await db.execute({
    sql: 'delete from crawl_hourly where hour < ?',
    args: [nowIso(-days * 86_400_000).slice(0, 13)],
  });
  return Number(rowsAffected ?? 0);
}

/**
 * The crawler's throughput hour by hour, ready to plot.
 *
 * Dense: every hour in the window is returned whether or not the table has a
 * row for it, because a bar chart that silently closes its gaps draws a quiet
 * night as if it were busy. `recorded` says whether the hour was written down
 * live; hours before the rollup existed know their item count and nothing else.
 *
 * @param {Client} db
 * @param {number} [hours] how far back to go
 * @returns {Promise<Array<{ hour: string, items: number, fetched: number, succeeded: number, failed: number, recorded: boolean }>>}
 */
export async function indexingHistory(db, hours = 48) {
  const start = nowIso(-(hours - 1) * 3_600_000).slice(0, 13);

  const { rows } = await db.execute({
    sql: `select hour, ticks, fetched, succeeded, failed, items
          from crawl_hourly where hour >= ? order by hour`,
    args: [start],
  });

  const byHour = new Map(rows.map((r) => [String(r.hour), r]));
  const series = [];

  // Walked from the start of the window in real hours rather than by
  // incrementing the string: '2026-08-31T23' + 1 is a date, not arithmetic.
  const cursor = new Date(`${start}:00:00.000Z`);
  for (let i = 0; i < hours; i += 1) {
    const key = cursor.toISOString().slice(0, 13);
    const row = byHour.get(key);
    series.push({
      hour: key,
      items: Number(row?.items ?? 0),
      fetched: Number(row?.fetched ?? 0),
      succeeded: Number(row?.succeeded ?? 0),
      failed: Number(row?.failed ?? 0),
      recorded: Number(row?.ticks ?? 0) > 0,
    });
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  return series;
}

/**
 * Write lines to the crawler's log.
 *
 * One statement per call, because the poller buffers a couple of seconds of
 * lines and hands them over together. This used to be one INSERT statement per
 * line inside an explicit write transaction. Under Turso write throttling that
 * transaction joined the same scarce queue as feed storage, timed out, and
 * dropped the very daemon errors /crawlstats was meant to expose.
 *
 * A multi-row autocommit INSERT is still one atomic statement, needs no explicit
 * transaction, and stays off the crawler's transaction queue. The recorder caps
 * a flush at 501 rows (including a dropped-lines marker), so its 4,008 bound
 * parameters remain comfortably below SQLite's limit.
 *
 * Every field but `at` and `event` is optional — a line only fills in the
 * columns it has something to say about.
 *
 * @param {Client} db
 * @param {Array<{ event: string, at?: string, status?: string|null, subject?: string|null, slug?: string|null, amount?: number|null, detail?: string|null, ms?: number|null }>} entries
 * @returns {Promise<number>} lines written
 */
export async function appendCrawlLog(db, entries) {
  const rows = (Array.isArray(entries) ? entries : [entries]).filter((e) => e?.event);
  if (rows.length === 0) return 0;

  const args = rows.flatMap((entry) => [
    entry.at ?? nowIso(),
    String(entry.event),
    entry.status == null ? null : String(entry.status),
    entry.subject == null ? null : String(entry.subject),
    entry.slug == null ? null : String(entry.slug),
    entry.amount == null ? null : Number(entry.amount),
    entry.detail == null ? null : String(entry.detail),
    entry.ms == null ? null : Number(entry.ms),
  ]);

  await db.execute({
    sql: `insert into crawl_log (at, event, status, subject, slug, amount, detail, ms)
          values ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    args,
  });
  return rows.length;
}

/**
 * Read the crawler's log forward from a cursor.
 *
 * The cursor is the row id, not the timestamp. Two lines written in the same
 * millisecond are ordinary here — a batch flush writes twenty-five at once — and
 * a timestamp cursor would silently drop every line that shared the last one's
 * millisecond. Ids are handed to the client as the SSE event id, so a reconnect
 * resumes exactly where the connection dropped.
 *
 * Ascending, so a caller can append what it gets and take the last id as its
 * next cursor.
 *
 * @param {Client} db
 * @param {{ since?: number|null, limit?: number }} [opts]
 * @returns {Promise<Array<object>>} oldest first
 */
export async function crawlLog(db, { since = null, limit = 200 } = {}) {
  const { rows } = await db.execute({
    sql: `select id, at, event, status, subject, slug, amount, detail, ms
          from crawl_log where id > ? order by id asc limit ?`,
    args: [Number(since ?? 0), Math.max(1, Math.min(Number(limit) || 200, 1000))],
  });
  return rows;
}

/**
 * The newest lines in the log, for a page that has not streamed anything yet.
 *
 * Read newest-first so the limit takes the tail rather than the head, then
 * reversed: the caller renders a log, and a log reads downwards.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<Array<object>>} oldest first
 */
export async function crawlLogTail(db, limit = 60) {
  const { rows } = await db.execute({
    sql: `select id, at, event, status, subject, slug, amount, detail, ms
          from crawl_log order by id desc limit ?`,
    args: [Math.max(1, Math.min(Number(limit) || 60, 1000))],
  });
  return [...rows].reverse();
}

/**
 * Recent daemon failures, independently of the rolling feed log.
 *
 * A busy crawler emits hundreds of successful feed lines in minutes, so an
 * operational error disappears from the live panel's bounded window long
 * before somebody opens the status page. Feed failures already have their own
 * table below it; this query deliberately returns only daemon/job failures.
 *
 * @param {Client} db
 * @param {{ limit?: number, hours?: number }} [opts]
 * @returns {Promise<Array<object>>} newest first
 */
export async function crawlOperationalErrors(db, { limit = 20, hours = 24 } = {}) {
  const { rows } = await db.execute({
    sql: `select id, at, event, status, subject, slug, amount, detail, ms
          from crawl_log
          where status = 'error' and event <> 'feed' and at >= ?
          order by id desc limit ?`,
    args: [
      nowIso(-Math.max(1, Number(hours) || 24) * 3_600_000),
      Math.max(1, Math.min(Number(limit) || 20, 100)),
    ],
  });
  return rows;
}

/**
 * Drop log lines older than the window the page shows.
 *
 * Hours rather than days: this table takes a row per feed crawled, so a week of
 * retention would be a quarter of a million rows to hold a log nobody scrolls
 * back through. Railway keeps the durable copy of the same lines.
 *
 * @param {Client} db
 * @param {number} [hours]
 * @returns {Promise<number>} rows removed
 */
export async function pruneCrawlLog(db, hours = 12) {
  const { rowsAffected } = await db.execute({
    sql: 'delete from crawl_log where at < ?',
    args: [nowIso(-hours * 3_600_000)],
  });
  return Number(rowsAffected ?? 0);
}

/**
 * What the directory holds, broken down by category, with each category's own
 * growth curve.
 *
 * Two grouped scans of `feeds` and no join: attributing posts to a category
 * through feed_items takes over three minutes against production, because it is
 * 1.4M item rows looking up their feed. `feeds.item_count` is the same number,
 * maintained by the crawler on every successful fetch, and it is already on the
 * row being grouped.
 *
 * The growth series is cumulative and dense — one point per day, carried
 * forward across days when nothing was added — and it is reconstructed from
 * `created_at` rather than stored, so it is true history rather than a rollup
 * that only starts when somebody remembered to record it. It counts back from
 * today's total, so a category's line always ends at the number beside it.
 *
 * Dead feeds are excluded throughout, matching every other count in the app.
 *
 * @param {Client} db
 * @param {number} [days] length of the growth series
 * @returns {Promise<{ total: number, days: string[], categories: Array<object> }>}
 */
export async function categoryStats(db, days = 30) {
  const dayAgo = nowIso(-86_400_000);
  const weekAgo = nowIso(-7 * 86_400_000);
  const monthAgo = nowIso(-30 * 86_400_000);
  const windowStart = nowIso(-(days - 1) * 86_400_000).slice(0, 10);

  const [totals, added] = await Promise.all([
    db.execute({
      sql: `select category,
                   count(*)                                                       as feeds,
                   sum(case when status = 'active'  then 1 else 0 end)            as active,
                   sum(case when status = 'error'   then 1 else 0 end)            as errored,
                   sum(case when status = 'pending' then 1 else 0 end)            as pending,
                   sum(case when last_success_at >= ? then 1 else 0 end)          as crawled_day,
                   sum(case when created_at      >= ? then 1 else 0 end)          as added_day,
                   sum(case when created_at      >= ? then 1 else 0 end)          as added_week,
                   sum(case when created_at      >= ? then 1 else 0 end)          as added_month,
                   sum(item_count)                                                as items
            from feeds where status <> 'dead' group by category`,
      args: [dayAgo, dayAgo, weekAgo, monthAgo],
    }),
    db.execute({
      sql: `select substr(created_at, 1, 10) as day, category, count(*) as n
            from feeds where status <> 'dead' and created_at >= ?
            group by 1, 2`,
      args: [`${windowStart}T00:00:00.000Z`],
    }),
  ]);

  const labels = dayLabels(days);

  /** @type {Map<string, Map<string, number>>} category → day → feeds added */
  const addedByCategory = new Map();
  for (const row of added.rows) {
    const category = String(row.category);
    const perDay = addedByCategory.get(category) ?? new Map();
    perDay.set(String(row.day), Number(row.n ?? 0));
    addedByCategory.set(category, perDay);
  }

  const byCategory = new Map(totals.rows.map((r) => [String(r.category), r]));
  const total = totals.rows.reduce((n, r) => n + Number(r.feeds ?? 0), 0);

  const categories = KINDS.map((category) => {
    const row = byCategory.get(category);
    const feeds = Number(row?.feeds ?? 0);

    return {
      category,
      feeds,
      share: total > 0 ? feeds / total : 0,
      active: Number(row?.active ?? 0),
      errored: Number(row?.errored ?? 0),
      pending: Number(row?.pending ?? 0),
      crawledLastDay: Number(row?.crawled_day ?? 0),
      addedLastDay: Number(row?.added_day ?? 0),
      addedLastWeek: Number(row?.added_week ?? 0),
      addedLastMonth: Number(row?.added_month ?? 0),
      items: Number(row?.items ?? 0),
      growth: cumulativeBack(feeds, labels, addedByCategory.get(category) ?? new Map()),
    };
  });

  return { total, days: labels, categories };
}

/**
 * The last `days` dates, oldest first, as YYYY-MM-DD.
 *
 * @param {number} days
 * @returns {string[]}
 */
function dayLabels(days) {
  const labels = [];
  const cursor = new Date(nowIso(-(days - 1) * 86_400_000).slice(0, 10));

  for (let i = 0; i < days; i += 1) {
    labels.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return labels;
}

/**
 * Turn "feeds added on each day" into "feeds held at the end of each day".
 *
 * Worked backwards from today's total: the alternative is to count everything
 * older than the window as a starting balance, which is a third aggregate over
 * the whole table for a number that subtraction already has.
 *
 * @param {number} total feeds in the category now
 * @param {string[]} labels days, oldest first
 * @param {Map<string, number>} added day → feeds added that day
 * @returns {number[]} one running total per label
 */
function cumulativeBack(total, labels, added) {
  const series = new Array(labels.length);
  let running = total;

  for (let i = labels.length - 1; i >= 0; i -= 1) {
    series[i] = running;
    running -= added.get(labels[i]) ?? 0;
  }
  return series;
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

/** The columns a crawl needs off a feed row. Shared by both due queries. */
const DUE_COLUMNS = `id, slug, title, feed_url, error_count, fetch_interval_minutes, source_kind,
                 item_count, last_published_at,
                 http_etag, http_last_modified, content_hash, change_log`;

/**
 * The share of a tick reserved for hand-submitted feeds.
 *
 * Half, so the express lane cannot starve the backlog no matter how many
 * submissions arrive: a tick always spends at least half of itself on the
 * ordinary queue. In practice the reservation is never taken up — real people
 * submit a handful of blogs an hour against a batch of twenty-five — so this
 * is a ceiling on the pathological case rather than a division of normal work.
 */
const EXPRESS_SHARE = 0.5;

/**
 * Feeds a person submitted by hand and that have never been crawled.
 *
 * The express lane. Read before the ordinary queue because ordering the two
 * together cannot work: they are ordered by `next_fetch_at asc` and the backlog
 * is *older*, so a submission stamped `now` sorts last behind ~307,000 feeds
 * that were overdue before it arrived. Sorting by priority instead would put a
 * 416,000-row sort in front of every tick. Two reads, the first against a
 * partial index that is normally empty, is the cheap way to say "these first".
 *
 * `last_fetched_at is null` is in the predicate rather than being cleared after
 * the fact, so this expedites the *first* crawl only — which is the whole of
 * what a submitter is waiting for. Afterwards the feed is scheduled on its own
 * publishing rhythm like everything else.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function expressFeeds(db, limit = 25) {
  if (limit <= 0) return [];

  const { rows } = await db.execute({
    sql: `select ${DUE_COLUMNS}
          from feeds
          where priority > 0 and last_fetched_at is null
            and status <> 'dead' and next_fetch_at <= ?
          order by next_fetch_at asc limit ?`,
    args: [nowIso(), limit],
  });
  return rows;
}

/**
 * Feeds whose next_fetch_at has passed, hand-submitted ones first.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function dueFeeds(db, limit = 25) {
  // Bounded rather than unbounded even though the express table is tiny: the
  // point of a reserved share is that it is reserved in both directions.
  const express = await expressFeeds(db, Math.floor(limit * EXPRESS_SHARE));
  const remaining = limit - express.length;
  if (remaining <= 0) return express;

  const { rows } = await db.execute({
    // slug and title are along for the log: a crawler log line that names the
    // blog and links to its page is worth two columns the crawl itself is
    // holding the row for anyway. source_kind is what main added, and the
    // crawl still needs it to know what it is fetching.
    // item_count comes along so a crawl that stored nothing can pass the number
    // straight back instead of paying for a count(*) to be told it is unchanged.
    //
    // last_published_at is what the crawl compares the document against to
    // decide whether this publisher has published since we last looked -- the
    // guard that keeps topics and credits from being rewritten on every crawl of
    // an unchanged feed. It was missing from this select, so `knownPublished`
    // read null for every feed the poller crawled and the guard was open in
    // production the whole time.
    //
    // The last four are the conditional-request and change-detection signals
    // added in 0032: what the server's validators were, what the feed contained,
    // and when we last saw that change. They are what lets a feed stating no
    // dates be scheduled on evidence rather than on the doubling ladder.
    //
    // The express rows are excluded rather than deduplicated afterwards: they
    // have just been read and are about to be crawled, and handing the same
    // feed to two workers in one tick is two crawls of it.
    sql: `select ${DUE_COLUMNS}
          from feeds
          where status <> 'dead' and next_fetch_at <= ?
            and not (priority > 0 and last_fetched_at is null)
          order by next_fetch_at asc limit ?`,
    args: [nowIso(), remaining],
  });

  return express.concat(rows);
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
  // Counted by its complement, for the same reason `crawlStats` does: the
  // backlog is very nearly every feed in the directory (367k of 368k), so
  // counting the due rows walks almost the whole index — 4.8 seconds measured
  // against production — while counting the ~1,200 rows that are *not* due is
  // a short range read at 292ms. The poller called this once per tick to write
  // one number into its log line, and paid five seconds for it every time.
  const { rows } = await db.execute({
    sql: `select
            (select count(*) from feeds where status <> 'dead') as alive,
            (select count(*) from feeds where status <> 'dead' and next_fetch_at > ?) as waiting`,
    args: [nowIso()],
  });
  const alive = Number(rows[0]?.alive ?? 0);
  return Math.max(0, alive - Number(rows[0]?.waiting ?? 0));
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
            -- Only over a category this crawler derived. A curated one — the
            -- comics, lives and reels lists, none of which are visible to a
            -- parser — would otherwise be re-derived back to 'blog' on the
            -- feed's next crawl, which is to say within the hour.
            category = case when category_source = 'curated' then category else ? end,
            -- Kept when the feed stops declaring one rather than overwritten
            -- with nothing: a language that was true last week is a better
            -- answer than null, and null is what the reader's language bar is
            -- built from.
            language = coalesce(nullif(?, ''), language),
            last_fetched_at = ?, last_success_at = ?, last_error = null,
            error_count = 0,
            fetch_interval_minutes = ?, next_fetch_at = ?, item_count = ?, updated_at = ?
          where id = ?`,
    args: [
      feed.title,
      feed.description || null,
      feed.siteUrl || null,
      feed.imageUrl || null,
      // Re-derived on every crawl rather than set once at submission: a blog
      // that starts publishing audio becomes music, and the tens of thousands
      // of rows imported before this column existed get their real category
      // the first time the poller reaches them.
      normalizeKind(feed.kind) ?? 'blog',
      // Backfilled on every crawl for the same reason as the category above.
      // The catalogue arrived as 47k rows with no metadata at all, so a feed's
      // language is only ever learned by crawling it — and until it was written
      // back here, the language bar could offer nothing but the handful of
      // feeds that came in through the submit form.
      feed.language || null,
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
 * One statement with many rows of `values`, rather than many statements in one
 * batch. Both are a single round trip, so the difference is invisible against
 * local SQLite — and it is most of the wall-clock of a real import. Measured on
 * a throwaway Turso database in the production region: 500 rows as 500
 * statements takes ~7.1s, and the same 500 rows as one statement takes ~0.69s.
 * Ten times, for a change that alters no behaviour. Turso appears to settle each
 * write statement in a batch separately; a single statement is one unit of work
 * however many rows it carries.
 *
 * The chunking that calls this stays at 500, which is what keeps the parameter
 * count (nine per row, so 4,500) comfortably inside SQLite's limit.
 *
 * @param {Client} db
 * @param {Array<{ slug: string, feed_url: string, site_url?: string|null, title: string, next_fetch_at: string, submission_id?: string|null }>} feeds
 * @returns {Promise<number>} rows actually inserted
 */
export async function insertFeedsBulk(db, feeds) {
  if (feeds.length === 0) return 0;

  const now = nowIso();
  const row = `(?, ?, ?, ?, ?, null, null, null, null, '[]', 'pending', null, null, null, 0,
                60, ?, 0, ?, ?, ?, ?)`;

  const result = await db.execute({
    sql: `insert into feeds
      (id, slug, feed_url, site_url, title, description, language, image_url, author,
       categories, status, last_fetched_at, last_success_at, last_error, error_count,
       fetch_interval_minutes, next_fetch_at, item_count, submission_id, created_at, updated_at,
       priority)
      values ${feeds.map(() => row).join(', ')}
      on conflict do nothing`,
    args: feeds.flatMap((f) => [
      newId(),
      f.slug,
      f.feed_url,
      f.site_url ?? null,
      f.title,
      f.next_fetch_at,
      f.submission_id ?? null,
      now,
      now,
      // Zero unless the caller is putting a hand-submitted feed in the express
      // lane. Written here rather than defaulted by the column so that a row
      // inserted by an import is explicit about not being expedited.
      Number(f.priority) > 0 ? 1 : 0,
    ]),
  });

  return Number(result.rowsAffected ?? 0);
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
 * Which of these feed URLs the directory already holds.
 *
 * The scoped counterpart to {@link existingFeedKeys}. That one reads the whole
 * table, which is right when a single process imports a whole catalogue in one
 * go — the read is amortised over every row of the file. It is exactly wrong
 * for an upload that arrives as a few hundred separate HTTP requests: each one
 * would re-read fifty thousand rows to check two thousand URLs, and the cost
 * grows with the directory rather than with the upload.
 *
 * Matched on the exact stored string rather than a lowercased one, so the
 * unique index on feed_url can answer it. That is also the only comparison that
 * means anything here: the index is what `insertFeedsBulk` conflicts against,
 * so a URL this misses is a URL the insert would have dropped anyway.
 *
 * @param {Client} db
 * @param {string[]} urls normalized feed URLs
 * @returns {Promise<Set<string>>} the subset that already exists
 */
export async function knownFeedUrls(db, urls) {
  return lookupIn(db, 'select feed_url from feeds where feed_url in', urls, (url) => url);
}

/**
 * Which of these slugs are already claimed.
 *
 * @param {Client} db
 * @param {string[]} slugs
 * @returns {Promise<Set<string>>}
 */
export async function knownSlugs(db, slugs) {
  return lookupIn(db, 'select slug from feeds where slug in', slugs, (slug) => slug);
}

/**
 * Run one `where x in (…)` lookup over a list of any length.
 *
 * SQLite has a ceiling on bound parameters per statement, and a batch import
 * hands us a couple of thousand keys at a time, so the list is asked for in
 * pages. Five hundred is well under every version's limit and still turns a
 * two-thousand-key check into four round trips rather than two thousand.
 *
 * @param {Client} db
 * @param {string} prefix SQL up to and including `in`
 * @param {string[]} values
 * @param {(value: unknown) => string} key how a returned row maps back to the set
 * @returns {Promise<Set<string>>}
 */
async function lookupIn(db, prefix, values, key) {
  const found = new Set();
  const page = 500;

  for (let i = 0; i < values.length; i += page) {
    const slice = values.slice(i, i + page);
    if (slice.length === 0) break;

    const { rows } = await db.execute({
      sql: `${prefix} (${slice.map(() => '?').join(', ')})`,
      args: slice,
    });
    for (const row of rows) found.add(key(String(Object.values(row)[0])));
  }

  return found;
}

/**
 * Record entries against a submission without queueing any of them.
 *
 * Everything the queueing does — normalising, deduplicating, claiming slugs,
 * scheduling — is the poller's job now, so this is one insert and nothing else.
 * That is the point: it is what lets a very large catalogue be handed over in a
 * minute instead of half an hour, and the tab closed.
 *
 * One statement with many rows, for the reason `insertFeedsBulk` documents.
 *
 * @param {Client} db
 * @param {string} submissionId
 * @param {Array<{ url: string, title?: string|null, siteUrl?: string|null }>} entries
 * @returns {Promise<number>}
 */
export async function stageImportEntries(db, submissionId, entries) {
  if (entries.length === 0) return 0;

  const result = await db.execute({
    sql:
      `insert into import_entries (submission_id, url, title, site_url) values ` +
      entries.map(() => '(?, ?, ?, ?)').join(', '),
    args: entries.flatMap((e) => [
      submissionId,
      String(e.url ?? ''),
      e.title == null ? null : String(e.title),
      e.siteUrl == null ? null : String(e.siteUrl),
    ]),
  });

  return Number(result.rowsAffected ?? 0);
}

/**
 * Mark a submission's list complete, so the poller may start draining it.
 *
 * `notify_email` is written here for the reason `completeSubmission` gives: an
 * address stored while there was still nothing queued reads as a finished
 * import and gets mailed about immediately.
 *
 * @param {Client} db
 * @param {string} id
 * @param {{ entries_total?: number, rejected_count?: number, notify_email?: string|null }} row
 */
export async function markImportReady(db, id, row) {
  await db.execute({
    sql: `update submissions
          set entries_ready_at = ?, entries_total = ?, rejected_count = ?, notify_email = ?
          where id = ?`,
    args: [
      nowIso(),
      Math.max(0, Math.floor(Number(row.entries_total ?? 0)) || 0),
      Math.max(0, Math.floor(Number(row.rejected_count ?? 0)) || 0),
      row.notify_email ?? null,
      id,
    ],
  });
}

/**
 * The next submission with a finished list and rows still to drain.
 *
 * Oldest first, so a catalogue uploaded while another is draining waits its turn
 * rather than interleaving with it — which would put both imports' feeds in one
 * another's crawl schedule.
 *
 * @param {Client} db
 * @returns {Promise<{ id: string, entries_total: number }|null>}
 */
export async function nextImportToDrain(db) {
  const { rows } = await db.execute({
    sql: `select s.id, s.entries_total
          from submissions s
          where s.entries_ready_at is not null
            and exists (select 1 from import_entries e where e.submission_id = s.id)
          order by s.entries_ready_at asc
          limit 1`,
  });

  const row = rows[0];
  if (!row) return null;
  return { id: String(row.id), entries_total: Number(row.entries_total ?? 0) };
}

/**
 * Take a slice of a submission's staged entries, oldest first.
 *
 * @param {Client} db
 * @param {string} submissionId
 * @param {number} limit
 * @returns {Promise<Array<{ id: number, url: string, title: string, siteUrl: string|null }>>}
 */
export async function takeImportEntries(db, submissionId, limit) {
  const { rows } = await db.execute({
    sql: `select id, url, title, site_url from import_entries
          where submission_id = ? order by id asc limit ?`,
    args: [submissionId, limit],
  });

  return rows.map((r) => ({
    id: Number(r.id),
    url: String(r.url),
    title: r.title == null ? '' : String(r.title),
    siteUrl: r.site_url == null ? null : String(r.site_url),
  }));
}

/**
 * Forget entries once they have been queued.
 *
 * Deleted by id rather than by submission so that a drain interrupted halfway
 * resumes where it stopped instead of starting again.
 *
 * @param {Client} db
 * @param {number[]} ids
 * @returns {Promise<number>}
 */
export async function dropImportEntries(db, ids) {
  if (ids.length === 0) return 0;

  const result = await db.execute({
    sql: `delete from import_entries where id in (${ids.map(() => '?').join(',')})`,
    args: ids,
  });

  return Number(result.rowsAffected ?? 0);
}

/**
 * How many of a submission's entries are still waiting to be queued.
 *
 * @param {Client} db
 * @param {string} submissionId
 * @returns {Promise<number>}
 */
export async function countImportEntries(db, submissionId) {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from import_entries where submission_id = ?',
    args: [submissionId],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * The IP hash a submission was made from, for deciding who may add to it.
 *
 * An upload that arrives in hundreds of separate requests has to name the
 * submission it belongs to, and a submission id is a public URL — it is printed
 * on the status page. That is fine for reading and wrong for writing, so a
 * batch is only accepted from the address that opened the submission.
 *
 * @param {Client} db
 * @param {string} id
 * @returns {Promise<{ ip_hash: string|null, created_at: string }|null>}
 */
export async function submissionOwner(db, id) {
  const { rows } = await db.execute({
    sql: 'select ip_hash, created_at from submissions where id = ? limit 1',
    args: [id],
  });
  const row = rows[0];
  if (!row) return null;
  return {
    ip_hash: row.ip_hash == null ? null : String(row.ip_hash),
    created_at: String(row.created_at),
  };
}

/**
 * The YouTube channels the directory already indexes.
 *
 * Discovery normally starts from a list somebody else maintains. This one
 * starts from the directory itself: every channel here was already judged worth
 * a page, and the playlists on it — a course, a conference track, an album —
 * are the ordered works the channel feed flattens into "newest upload first".
 *
 * Ordered by rowid so the slice a run takes is stable between passes, which is
 * what lets the caller rotate through the whole set by run number instead of
 * storing a cursor.
 *
 * @param {Client} db
 * @returns {Promise<string[]>} channel ids
 */
export async function youtubeChannelIds(db) {
  const { rows } = await db.execute(
    `select feed_url from feeds
     where feed_url like '%youtube.com/feeds/videos.xml?channel_id=%'
     order by rowid`,
  );

  const ids = [];
  for (const row of rows) {
    const match = String(row.feed_url).match(/[?&]channel_id=(UC[\w-]{10,})/);
    if (match) ids.push(match[1]);
  }

  return ids;
}

/**
 * Settle a feed that was read successfully and had not changed.
 *
 * The cheapest crawl there is, and the one this whole change exists to make
 * common. Nothing was published, so there are no items to upsert, no topics to
 * re-derive, no byline to re-check and no count to recompute -- a single-row
 * update by primary key, which on this database is one write transaction where a
 * full crawl is one write transaction doing considerably more inside it.
 *
 * `item_count` is deliberately not recomputed. It cannot have changed: nothing
 * was written. Recomputing it would add a `count(*)` over feed_items to the one
 * path in the crawler that has no reason to touch that table at all.
 *
 * @param {Client} db
 * @param {string} id
 * @param {number} minutes when to come back
 * @param {{ etag?: string|null, lastModified?: string|null, contentHash?: string|null, changeLog?: string|null }} [signals]
 */
export async function markUnchanged(db, id, minutes, signals = {}) {
  const now = nowIso();
  await db.execute({
    sql: `update feeds set
            status = 'active', last_fetched_at = ?, last_success_at = ?,
            last_error = null, error_count = 0,
            fetch_interval_minutes = ?, next_fetch_at = ?,
            http_etag = coalesce(?, http_etag),
            http_last_modified = coalesce(?, http_last_modified),
            content_hash = coalesce(?, content_hash),
            change_log = coalesce(?, change_log),
            updated_at = ?
          where id = ?`,
    args: [
      now,
      now,
      minutes,
      nowIso(minutes * 60_000),
      signals.etag ?? null,
      signals.lastModified ?? null,
      signals.contentHash ?? null,
      signals.changeLog ?? null,
      now,
      id,
    ],
  });
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
 * Come back later, and hold every judgement about this feed.
 *
 * The counterpart to `markCrawlFailure` for a server that answered 429 -- or 503
 * with a Retry-After. Only the schedule moves: `status`, `error_count` and
 * `last_error` are left exactly as they were, and `last_success_at` with them.
 *
 * `last_fetched_at` is *not* stamped either, and that is the subtle one. It
 * means "when we last read this publisher", and a throttle is precisely the case
 * where we did not read them. Stamping it would make a feed we have been bounced
 * from for a day look freshly crawled on every page that reports staleness.
 *
 * @param {Client} db
 * @param {string} id
 * @param {number} minutes
 * @returns {Promise<void>}
 */
export async function markThrottled(db, id, minutes) {
  const wait = Math.max(1, Math.round(Number(minutes) || 30));
  await db.execute({
    sql: 'update feeds set next_fetch_at = ?, updated_at = ? where id = ?',
    args: [nowIso(wait * 60_000), nowIso(), id],
  });
}

/* ------------------------------------------------------------- feed cards */

/**
 * Feeds still waiting for somebody to go and look at their picture.
 *
 * Ordered by when we last looked, nulls first, which reads as: answer every
 * feed that has never been checked, then retry the failures oldest-first. The
 * partial index in 0023 covers exactly this set, so the query stays cheap as the
 * 52,000 unchecked rows drain away — and costs nothing at all once they have.
 *
 * A dead feed is skipped. Its page still exists, but sending requests to a
 * publisher who stopped responding ten crawls ago to decorate it is not a
 * trade worth making.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @param {number} [retryAfterMs] how long a failed look is left alone
 * @returns {Promise<object[]>}
 */
export async function feedsNeedingCard(db, limit = 10, retryAfterMs = 30 * 86_400_000) {
  const { rows } = await db.execute({
    sql: `select id, slug, site_url, image_url, card_state
          from feeds
          where card_state is not 'ok'
            and status <> 'dead'
            and (card_checked_at is null or card_checked_at < ?)
          order by card_checked_at asc
          limit ?`,
    args: [nowIso(-retryAfterMs), limit],
  });
  return rows;
}

/**
 * Record what the look found.
 *
 * `card_checked_at` is written on every outcome, including the failures: the
 * queue above is ordered by it, so a row that failed and kept a null timestamp
 * would be handed back on the very next pass forever, and one unreachable site
 * would starve the rest of the directory.
 *
 * @param {Client} db
 * @param {string} id
 * @param {{ state: 'ok'|'none'|'error', url?: string, width?: number, height?: number, type?: string }} card
 */
export async function setFeedCard(db, id, card) {
  const ok = card.state === 'ok' && card.url;

  await db.execute({
    sql: `update feeds set
            card_url = ?, card_width = ?, card_height = ?, card_type = ?,
            card_state = ?, card_checked_at = ?
          where id = ?`,
    args: [
      ok ? String(card.url) : null,
      ok && card.width ? Math.trunc(card.width) : null,
      ok && card.height ? Math.trunc(card.height) : null,
      ok && card.type ? String(card.type) : null,
      card.state,
      nowIso(),
      id,
    ],
  });
}

/**
 * How far the card backfill has got. Read by /crawlstats, and by anyone asking
 * whether it is worth waiting for.
 *
 * @param {Client} db
 * @returns {Promise<{ ok: number, none: number, error: number, pending: number }>}
 */
export async function cardCoverage(db) {
  const { rows } = await db.execute(
    `select
       sum(case when card_state = 'ok' then 1 else 0 end) as ok,
       sum(case when card_state = 'none' then 1 else 0 end) as none,
       sum(case when card_state = 'error' then 1 else 0 end) as error,
       sum(case when card_state is null then 1 else 0 end) as pending
     from feeds`,
  );

  const row = rows[0] ?? {};
  return {
    ok: Number(row.ok ?? 0),
    none: Number(row.none ?? 0),
    error: Number(row.error ?? 0),
    pending: Number(row.pending ?? 0),
  };
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
 * `kinds` narrows the hits to one sub-filter's worth of categories — the
 * podcasts on a subject rather than everything on it. It has to be a filter on
 * the results rather than a different index: what a post is filed as lives on
 * its feed, and the directory is nine parts blog by volume, so without it the
 * forty best matches for anything are forty blog posts and the podcasts that
 * matched are never seen. See searchKindCounts.
 *
 * Ordered by `bm25(...)` rather than by `rank`, which is the same ordering —
 * `rank` *is* bm25 with unit weights — reached by a very different query plan.
 * With a category filter in the WHERE clause, `order by rank` makes SQLite walk
 * the match set the expensive way round: measured against production, a sparse
 * category on a common word took 2-4s that way and 0.1-1.2s this way. Unfiltered
 * the two are level, so both use the same shape rather than branching on it.
 *
 * @param {Client} db
 * @param {string} query
 * @param {number} [limit]
 * @param {'all'|'any'} [mode]
 * @param {string[]|null} [kinds] categories to keep, or null for every kind
 * @returns {Promise<object[]>}
 */
export async function searchItems(db, query, limit = 40, mode = 'all', kinds = null) {
  const match = ftsQuery(query, mode);
  if (!match) return [];

  const filter = kindFilter(normalizeKinds(kinds));

  const { rows } = await db.execute({
    sql: `select i.guid, i.title, i.url, i.summary, i.published_at, i.image_url,
                 f.slug as feed_slug, f.title as feed_title, f.category,
                 f.image_url as feed_image, f.card_url as feed_card
          from feed_items_fts
          join feed_items i on i.rowid = feed_items_fts.rowid
          join feeds f on f.id = i.feed_id
          where feed_items_fts match ?${filter.sql}
          order by bm25(feed_items_fts)
          limit ?`,
    args: [match, ...filter.args, limit],
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
 * @param {string[]|null} [kinds] categories to keep, or null for every kind
 * @returns {Promise<object[]>}
 */
export async function searchFeeds(db, query, limit = 20, mode = 'all', kinds = null) {
  const match = ftsQuery(query, mode);
  if (!match) return [];

  const filter = kindFilter(normalizeKinds(kinds));

  const { rows } = await db.execute({
    sql: `select f.slug, f.title, f.description, f.image_url, f.card_url, f.category
          from feeds_fts
          join feeds f on f.rowid = feeds_fts.rowid
          where feeds_fts match ?${filter.sql}
          order by bm25(feeds_fts)
          limit ?`,
    args: [match, ...filter.args, limit],
  });
  return rows;
}

/**
 * How many posts and blogs a query matches in each category.
 *
 * This is what lets the results page offer its sub-filters honestly: only the
 * categories that have something are linked, and each says how much it has, so
 * "podcast 1,521" is visible even when every one of the forty rows on screen is
 * a blog post. Both halves are counted because both are filtered — a podcast
 * sub-filter shows matching shows as well as matching episodes.
 *
 * Deliberately unordered. A grouped count over the whole match set is cheap
 * (~110ms against production, on a word matching 26k posts) precisely because
 * nothing is ranked; adding an order to it is what made the same scan take
 * seconds. Counts are therefore exact rather than sampled from the top N, which
 * a rank-ordered window would have made them.
 *
 * @param {Client} db
 * @param {string} query
 * @param {'all'|'any'} [mode]
 * @returns {Promise<{ posts: Record<string, number>, feeds: Record<string, number> }>}
 */
export async function searchKindCounts(db, query, mode = 'all') {
  const match = ftsQuery(query, mode);
  if (!match) return { posts: {}, feeds: {} };

  const [posts, feeds] = await Promise.all([
    db.execute({
      sql: `select f.category, count(*) as n
            from feed_items_fts
            join feed_items i on i.rowid = feed_items_fts.rowid
            join feeds f on f.id = i.feed_id
            where feed_items_fts match ?
            group by f.category`,
      args: [match],
    }),
    db.execute({
      sql: `select f.category, count(*) as n
            from feeds_fts
            join feeds f on f.rowid = feeds_fts.rowid
            where feeds_fts match ?
            group by f.category`,
      args: [match],
    }),
  ]);

  /** @param {{ rows: object[] }} result */
  const tally = (result) => {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const row of result.rows) counts[String(row.category)] = Number(row.n ?? 0);
    return counts;
  };

  return { posts: tally(posts), feeds: tally(feeds) };
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
    sql: `select id, kind, raw_input, accepted_count, rejected_count, queued_count, errors,
                 entries_total, entries_ready_at, notify_email, notified_at, created_at
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

  // Feeds handed over but not yet turned into rows. Without this an upload
  // reads as finished the moment it is sent — nought of nought crawled — which
  // is the worst possible thing for the page to say about a catalogue that is
  // about to become half a million feeds.
  const { rows: staged } = await db.execute({
    sql: 'select count(*) as n from import_entries where submission_id = ?',
    args: [id],
  });
  const pending = Number(staged[0]?.n ?? 0);

  return { queued: crawled + failed + waiting, crawled, failed, waiting, pending };
}

/**
 * Fill in a submission's tallies once its inline half has finished.
 *
 * A submission that answers before it is done has to exist before it is done,
 * so the row is written first with zeroes and completed here. `notify_email` is
 * deliberately part of this update rather than of the insert: the poller treats
 * "has an address and has no pending feeds" as "owes an email", and a row
 * carrying an address during the moment before its feeds were queued would be
 * read as a finished import and mailed about immediately.
 *
 * @param {Client} db
 * @param {string} id
 * @param {{ accepted_count?: number, rejected_count?: number, queued_count?: number, errors?: unknown, notify_email?: string|null }} row
 */
export async function completeSubmission(db, id, row) {
  await db.execute({
    sql: `update submissions
          set accepted_count = ?, rejected_count = ?, queued_count = ?,
              errors = ?, notify_email = ?
          where id = ?`,
    args: [
      row.accepted_count ?? 0,
      row.rejected_count ?? 0,
      row.queued_count ?? 0,
      JSON.stringify(row.errors ?? []),
      row.notify_email ?? null,
      id,
    ],
  });
}

/**
 * A submission as a log: one line per feed the crawler has settled.
 *
 * `last_fetched_at` is the event time and is null until the crawler has been to
 * the feed, so "has it happened yet" needs no extra column — a pending feed
 * simply is not in the result. Ordered oldest first and filtered by `since`, it
 * appends to whatever the watcher is already showing.
 *
 * `tail` returns the most recent rows instead of the oldest, reversed back to
 * oldest-first, for someone opening an import that finished while they were
 * away — see the same option on discovery.eventsForRun.
 *
 * @param {Client} db
 * @param {string} id
 * @param {{ since?: string|null, limit?: number, tail?: boolean }} [opts]
 * @returns {Promise<object[]>}
 */
export async function submissionEvents(db, id, opts = {}) {
  const since = opts.since ?? null;
  const limit = opts.limit ?? 200;

  const sql = (direction) =>
    `select slug, title, status, last_error, item_count, last_fetched_at as at
     from feeds
     where submission_id = ?1 and last_fetched_at is not null
       and (?2 is null or last_fetched_at > ?2)
     order by last_fetched_at ${direction}
     limit ?3`;

  if (opts.tail) {
    const { rows } = await db.execute({ sql: sql('desc'), args: [id, since, limit] });
    return rows.reverse();
  }

  const { rows } = await db.execute({ sql: sql('asc'), args: [id, since, limit] });
  return rows;
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
            -- An upload records its address the moment its list is handed over,
            -- which is before a single feed of it exists. Without this clause
            -- "has an address and nothing pending" is true for that whole
            -- window, and the submitter is told their import finished seconds
            -- after starting it.
            and not exists (
              select 1 from import_entries e where e.submission_id = s.id
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
    sql: `select slug, title, feed_url, site_url, description, category, item_count, updated_at
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
 * `topic` narrows the export to one topic slug. It is an EXISTS rather than a
 * join because this query's contract is "a page of *feeds*", and the keyset
 * cursor below is on (title, id) of feeds alone. feed_keywords is keyed on
 * (feed_id, slug), so a join happens not to duplicate anything today — but it
 * would be one relaxed constraint away from emitting a feed twice, which in an
 * OPML export is a duplicate subscription and in a keyset cursor is a row that
 * gets skipped when the page boundary falls between the copies. A semi-join
 * cannot express that bug.
 *
 * @param {Client} db
 * @param {{ afterTitle?: string|null, afterId?: string|null, limit?: number, kind?: string|null, topic?: string|null }} [cursor]
 * @returns {Promise<object[]>}
 */
export async function feedsForExportPage(
  db,
  { afterTitle = null, afterId = null, limit = 2000, kind = null, topic = null } = {},
) {
  const resuming = afterTitle !== null && afterId !== null;

  const { rows } = await db.execute({
    sql: `select id, slug, title, feed_url, site_url, description, category, item_count, updated_at
          from feeds
          where status <> 'dead'
            ${kind ? 'and category = ?' : ''}
            ${topic ? 'and exists (select 1 from feed_keywords k where k.feed_id = feeds.id and k.slug = ?)' : ''}
            ${resuming ? 'and (title > ? or (title = ? and id > ?))' : ''}
          order by title asc, id asc
          limit ?`,
    args: [
      ...(kind ? [kind] : []),
      ...(topic ? [topic] : []),
      ...(resuming ? [afterTitle, afterTitle, afterId] : []),
      limit,
    ],
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
 * The filters are named rather than positional. They are both nullable strings
 * and they read alike at a call site, so `(db, 2000, 'homelab')` silently means
 * "the homelab *category*" — a filter that matches nothing and exports an empty
 * document, which looks like a dead directory rather than like a mistake.
 *
 * @param {Client} db
 * @param {number} [pageSize]
 * @param {{ kind?: string|null, topic?: string|null }} [filters]
 * @returns {AsyncGenerator<object, void, void>}
 */
export async function* eachFeedForExport(db, pageSize = 2000, filters = {}) {
  const { kind = null, topic = null } = filters;
  let afterTitle = null;
  let afterId = null;

  for (;;) {
    const rows = await feedsForExportPage(db, { afterTitle, afterId, limit: pageSize, kind, topic });
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

/**
 * What the directory can actually claim about its own reliability.
 *
 * Every figure here is measured rather than promised, which is the whole point
 * of the page it feeds. A published uptime *target* is a claim about the
 * future that nobody can check; these are claims about the past that anybody
 * can, and they get stronger as the service does rather than becoming
 * embarrassing when it does not.
 *
 * Four numbers, and what each is honestly evidence of:
 *
 *   * **hours the crawler recorded work in**, over the last 30 days. The poller
 *     writes one `crawl_hourly` row per tick, so an hour with no row is an hour
 *     it did nothing — a deploy, a crash, or a stall. It is a real availability
 *     measure for the crawler and it is *not* a measure of whether the website
 *     answered, which is a different question this database cannot see. The
 *     page says so rather than letting one stand in for the other.
 *   * **crawls in the last 24 hours**, and how many of them succeeded. A
 *     success rate over somebody else's servers is partly a measure of the open
 *     web rather than of us, which is also worth saying.
 *   * **the freshness of the directory itself**: how much of it is dormant. At
 *     the sampled 15.8% this is the most useful single fact a reader can have
 *     about what they are searching.
 *   * **the oldest scheduled check**, which bounds the freshness claim: no feed
 *     waits longer than this, by construction.
 *
 * Cheap by construction. The rollup is ~720 tiny rows; the dormancy counts come
 * off `feeds_last_published_idx` (0030); nothing here touches feed_items, which
 * is the join 0017 established must never appear on a page.
 *
 * @param {Client} db
 * @param {number} [days]
 * @returns {Promise<object>}
 */
export async function reliability(db, days = 30) {
  const hours = days * 24;
  const start = nowIso(-hours * 3_600_000).slice(0, 13);
  const dayAgo = nowIso(-86_400_000).slice(0, 13);
  const yearAgo = nowIso(-365 * 86_400_000);

  const [recorded, lastDay, states, dormant] = await Promise.all([
    // `min(hour)` rides along because without it this figure lies in the one
    // direction that matters. The rollup is younger than the window — it began
    // recording when 0017 shipped — so "30 hours with work out of 720" reads as
    // 4% availability when the truth is that the other 690 hours have no
    // records at all, not an outage. The window is therefore bounded by the
    // oldest row rather than by the calendar, and a hand-backfilled row
    // (`ticks = 0`, see 0017) is not evidence of the crawler running either.
    db.execute({
      sql: `select count(*) as n, min(hour) as oldest
            from crawl_hourly where hour >= ? and ticks > 0`,
      args: [start],
    }),
    db.execute({
      sql: `select coalesce(sum(fetched), 0) as fetched, coalesce(sum(succeeded), 0) as succeeded
            from crawl_hourly where hour >= ?`,
      args: [dayAgo],
    }),
    db.execute('select status, count(*) as n from feeds group by status'),
    // Split three ways rather than two: a feed we have not re-crawled since
    // 0030 shipped has no last_published_at, and counting those as "not
    // dormant" would overstate how alive the directory is. Unknown is its own
    // answer and shrinks on its own as the crawler comes round.
    //
    // Caught rather than allowed to throw, because the poller owns migration
    // and the web service does not wait for it: between a deploy going out and
    // the crawler booting, `last_published_at` does not exist yet and this
    // statement is a hard error. A reliability page that 500s during a deploy
    // is a bad joke, so the dormancy figures go missing for a few minutes
    // instead and the page says it does not know them.
    db
      .execute({
        sql: `select
                (select count(*) from feeds
                  where last_published_at is not null and last_published_at < ?) as dormant,
                (select count(*) from feeds
                  where last_published_at is not null and last_published_at >= ?) as publishing,
                (select min(next_fetch_at) from feeds where status <> 'dead') as soonest,
                (select max(next_fetch_at) from feeds where status <> 'dead') as furthest`,
        args: [yearAgo, yearAgo],
      })
      .catch(() => ({ rows: [] })),
  ]);

  const byStatus = new Map(states.rows.map((r) => [String(r.status), Number(r.n ?? 0)]));
  const total = [...byStatus.values()].reduce((a, b) => a + b, 0);
  // Absent entirely when the read above was refused, which is different from
  // "we looked and the answer is zero" — hence null rather than 0 below.
  const d = dormant.rows[0] ?? null;
  const known = d === null ? null : Number(d.dormant ?? 0) + Number(d.publishing ?? 0);

  const fetched = Number(lastDay.rows[0]?.fetched ?? 0);
  const succeeded = Number(lastDay.rows[0]?.succeeded ?? 0);

  // How far back the evidence actually goes. Whichever is shorter: the window
  // asked for, or the time since the first hour we have a record of.
  const oldest = recorded.rows[0]?.oldest ? Date.parse(`${recorded.rows[0].oldest}:00:00.000Z`) : null;
  const observed = oldest === null
    ? 0
    : Math.min(hours, Math.max(1, Math.ceil((Date.now() - oldest) / 3_600_000)));

  return {
    windowDays: days,
    // Hours the crawler recorded any work in, out of the hours we have been
    // watching — not out of the calendar window, which the rollup is younger
    // than. Capped at the observed window: a rollup row for an hour that has
    // not finished yet is still an hour it worked in.
    hoursRecorded: Math.min(Number(recorded.rows[0]?.n ?? 0), observed),
    hoursInWindow: observed,
    // Stated separately so the page can say "we have only been keeping this
    // record for two days" rather than quietly implying a month of history.
    hoursRequested: hours,
    fetchedLastDay: fetched,
    succeededLastDay: succeeded,
    successRate: fetched > 0 ? succeeded / fetched : null,
    feeds: total,
    active: byStatus.get('active') ?? 0,
    pending: byStatus.get('pending') ?? 0,
    errored: byStatus.get('error') ?? 0,
    // Null, not zero, when the column is not there yet: "we do not know how
    // much of the directory is dormant" and "none of it is dormant" are
    // opposite claims and the page has to be able to tell them apart.
    dormant: d === null ? null : Number(d.dormant ?? 0),
    publishing: d === null ? null : Number(d.publishing ?? 0),
    freshnessUnknown: known === null ? null : Math.max(0, total - known),
    soonestCheck: d?.soonest ? String(d.soonest) : null,
    furthestCheck: d?.furthest ? String(d.furthest) : null,
    generatedAt: nowIso(),
  };
}
