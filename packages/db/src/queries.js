import { clusterKey, dedupeItems } from '@rssamplifier/feed';

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
  author, categories, kind, category, category_source, status, last_fetched_at, last_success_at, last_error, error_count,
  fetch_interval_minutes, next_fetch_at, item_count, created_at, updated_at, source_kind`;

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
      (id, feed_id, guid, url, title, summary, content_html, author, image_url, published_at,
       categories, audio_url, audio_type, audio_bytes, audio_seconds, created_at, cluster_key)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (feed_id, guid) do update set
        -- An episode already stored keeps its row, but a re-crawl fills in the
        -- audio it was stored without. Items imported before the media columns
        -- existed would otherwise never gain a player, because the guid is
        -- already there and a do-nothing conflict skips the whole row.
        audio_url = coalesce(feed_items.audio_url, excluded.audio_url),
        audio_type = coalesce(feed_items.audio_type, excluded.audio_type),
        audio_bytes = coalesce(feed_items.audio_bytes, excluded.audio_bytes),
        audio_seconds = coalesce(feed_items.audio_seconds, excluded.audio_seconds)`,
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
    ],
  }));

  await db.batch(statements, 'write');
  return statements.length;
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
 * It walks the primary key with a cursor rather than searching for `cluster_key
 * is null`. Searching would be the obvious way to write this and it is the
 * wrong one: finding scattered null rows needs an index over the whole table to
 * stay quick, that index cannot be built here (see 0019_item_clusters.sql), and
 * without it the search degrades to a full scan that gets slower exactly as the
 * work nears completion — the last few rows would cost a scan of 1.4M each.
 * Walking the key the table is already ordered by costs one indexed range read
 * per pass and finishes in a predictable number of them.
 *
 * @param {Client} db
 * @param {number} [limit] rows per pass
 * @param {string} [afterId] cursor: the last id of the previous pass
 * @returns {Promise<{ scanned: number, keyed: number, cursor: string|null }>}
 *   `cursor` is null once the walk has reached the end of the table.
 */
export async function backfillClusterKeys(db, limit = 500, afterId = '') {
  const { rows } = await db.execute({
    sql: `select id, title, cluster_key from feed_items
          where id > ? order by id limit ?`,
    args: [afterId, limit],
  });

  if (rows.length === 0) return { scanned: 0, keyed: 0, cursor: null };

  const cursor = String(rows[rows.length - 1].id);

  // Rows keyed on the way in are the overwhelming majority once the directory
  // has been running a while, and rewriting them would be pure write traffic
  // for no change.
  const pending = rows.filter((row) => row.cluster_key === null);
  if (pending.length === 0) return { scanned: rows.length, keyed: 0, cursor };

  let keyed = 0;
  const statements = pending.map((row) => {
    const key = clusterKey(String(row.title ?? '')) ?? '';
    if (key) keyed += 1;
    return {
      sql: `update feed_items set cluster_key = ? where id = ?`,
      args: [key, row.id],
    };
  });

  await db.batch(statements, 'write');
  return { scanned: rows.length, keyed, cursor };
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
  const statements = [
    { sql: 'delete from feed_keywords where feed_id = ?', args: [feedId] },
    ...keywords.map((k) => ({
      sql: `insert into feed_keywords (feed_id, slug, keyword, words, count, source)
            values (?, ?, ?, ?, ?, ?)
            on conflict (feed_id, slug) do nothing`,
      args: [feedId, k.slug, k.keyword, k.words ?? 1, k.count ?? 0, k.source ?? 'content'],
    })),
  ];

  // One batch, so a feed is never left with its old topics deleted and its new
  // ones unwritten.
  await db.batch(statements, 'write');
  return keywords.length;
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
    sql: `select f.slug, f.title, f.description, f.site_url, f.category, f.item_count,
                 k.keyword, k.count, k.source
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
                 f.slug as feed_slug, f.title as feed_title, f.feed_url, f.category
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
 * The topics index, from the rollup.
 *
 * @param {Client} db
 * @param {{ limit?: number, offset?: number, minFeeds?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listTopics(db, opts = {}) {
  const { limit = 200, offset = 0, minFeeds = 2 } = opts;

  const { rows } = await db.execute({
    sql: `select slug, keyword, feed_count from topics
          where feed_count >= ?
          order by feed_count desc, slug asc
          limit ? offset ?`,
    args: [minFeeds, limit, offset],
  });
  return rows;
}

/**
 * @param {Client} db
 * @param {number} [minFeeds]
 * @returns {Promise<number>}
 */
export async function countTopics(db, minFeeds = 2) {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from topics where feed_count >= ?',
    args: [minFeeds],
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
 * One batch per call, because the poller buffers a couple of seconds of lines
 * and hands them over together: a crawl batch produces twenty-five of these and
 * twenty-five separate round trips to Turso would cost more than the crawl.
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

  const statements = rows.map((entry) => ({
    sql: `insert into crawl_log (at, event, status, subject, slug, amount, detail, ms)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      entry.at ?? nowIso(),
      String(entry.event),
      entry.status == null ? null : String(entry.status),
      entry.subject == null ? null : String(entry.subject),
      entry.slug == null ? null : String(entry.slug),
      entry.amount == null ? null : Number(entry.amount),
      entry.detail == null ? null : String(entry.detail),
      entry.ms == null ? null : Number(entry.ms),
    ],
  }));

  await db.batch(statements, 'write');
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

/**
 * Feeds whose next_fetch_at has passed.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function dueFeeds(db, limit = 25) {
  const { rows } = await db.execute({
    // slug and title are along for the log: a crawler log line that names the
    // blog and links to its page is worth two columns the crawl itself is
    // holding the row for anyway. source_kind is what main added, and the
    // crawl still needs it to know what it is fetching.
    sql: `select id, slug, title, feed_url, error_count, fetch_interval_minutes, source_kind
          from feeds
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
    sql: `select id, kind, raw_input, accepted_count, rejected_count, queued_count, errors,
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
 * @param {Client} db
 * @param {{ afterTitle?: string|null, afterId?: string|null, limit?: number, kind?: string|null }} [cursor]
 * @returns {Promise<object[]>}
 */
export async function feedsForExportPage(
  db,
  { afterTitle = null, afterId = null, limit = 2000, kind = null } = {},
) {
  const resuming = afterTitle !== null && afterId !== null;

  const { rows } = await db.execute({
    sql: `select id, slug, title, feed_url, site_url, description, category, item_count, updated_at
          from feeds
          where status <> 'dead'
            ${kind ? 'and category = ?' : ''}
            ${resuming ? 'and (title > ? or (title = ? and id > ?))' : ''}
          order by title asc, id asc
          limit ?`,
    args: [
      ...(kind ? [kind] : []),
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
 * @param {Client} db
 * @param {number} [pageSize]
 * @param {string|null} [kind] one category, or null for the whole directory
 * @returns {AsyncGenerator<object, void, void>}
 */
export async function* eachFeedForExport(db, pageSize = 2000, kind = null) {
  let afterTitle = null;
  let afterId = null;

  for (;;) {
    const rows = await feedsForExportPage(db, { afterTitle, afterId, limit: pageSize, kind });
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
