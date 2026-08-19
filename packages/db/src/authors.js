import { newId, nowIso } from './client.js';

/**
 * Reading and writing the people behind the feeds.
 *
 * Every write here is idempotent, because the enrichment pass that calls them
 * re-runs over the whole directory on a slow loop: a feed looked at again next
 * month must update what is stored rather than create a second copy of the
 * same person. The unique constraints do that work — `identity_key` on
 * authors, `(author_id, url)` on links, the composite key on feed_authors —
 * and the upserts are written to lean on them rather than to check first,
 * which would race against the other workers in the same pass.
 *
 * @typedef {import('@libsql/client').Client} Client
 */

/**
 * Feeds waiting to be looked at for authorship, least recently checked first.
 *
 * Only active feeds. A feed in `error` or `dead` is one whose site may well be
 * gone, and spending the enrichment budget on it means not spending it on the
 * thousands that answer — the same reasoning `dueFeeds` uses for crawling.
 *
 * Nulls sort first in SQLite, which is the order this wants: never-checked
 * before checked-a-year-ago.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @param {string} [recheckBefore] ISO stamp; a feed checked after it is skipped
 * @returns {Promise<Array<{ id: string, slug: string, feed_url: string, site_url: string|null, title: string }>>}
 */
export async function dueForAuthors(db, limit = 25, recheckBefore = '') {
  const { rows } = await db.execute({
    sql: `select id, slug, feed_url, site_url, title
            from feeds
           where status = 'active'
             and (authors_checked_at is null or authors_checked_at < ?)
           order by authors_checked_at asc
           limit ?`,
    args: [recheckBefore || nowIso(), limit],
  });

  return /** @type {any} */ (rows);
}

/**
 * Record that a feed's enrichment *failed*, so it is tried again sooner.
 *
 * `markAuthorsChecked` is right for a miss — a site that genuinely names nobody
 * should not be re-read tomorrow — and wrong for a failure. They were the same
 * call, which meant a DNS hiccup, a timeout or a 503 cost that publisher its
 * enrichment for the **full recheck cycle**, ninety days, on the strength of one
 * bad afternoon. On a pass that has so far reached 3,275 of 369,056 feeds, that
 * is a quiet way to lose the ones on flaky hosts permanently.
 *
 * Done by back-dating the stamp rather than by adding an attempts column, and
 * that is a deliberate trade. Writes on this database serialize and the crawl
 * is already write-bound (see the notes in `crawl.js`), so the cheap fix that
 * costs one UPDATE beats the tidy one that costs a migration and a second
 * column to read. The feed still counts as "looked at" for the backlog, and
 * still comes due again in `retryDays`.
 *
 * It must never back-date past *now*: a stamp in the future would hide the feed
 * from a pass whose recheck window is shorter than this one's.
 *
 * @param {Client} db
 * @param {string} feedId
 * @param {{ retryDays?: number, recheckDays?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function markAuthorsFailed(db, feedId, opts = {}) {
  const retryDays = Math.max(0, Number(opts.retryDays ?? 3));
  const recheckDays = Math.max(retryDays, Number(opts.recheckDays ?? 90));

  // Stamped as though it were checked (recheckDays - retryDays) ago, so the
  // ordinary due test brings it back in retryDays without knowing why.
  const backdated = (recheckDays - retryDays) * 86_400_000;
  const at = new Date(Date.now() - backdated).toISOString();

  await db.execute({
    sql: 'update feeds set authors_checked_at = ? where id = ?',
    args: [at, feedId],
  });
}

/**
 * Record that a feed has been looked at, whether or not anyone was found.
 *
 * Stamped even on a miss, and that is the point: without it every pass would
 * re-examine the same authorless feeds forever and never reach the rest of the
 * directory.
 *
 * @param {Client} db
 * @param {string} feedId
 * @returns {Promise<void>}
 */
export async function markAuthorsChecked(db, feedId) {
  await db.execute({
    sql: 'update feeds set authors_checked_at = ? where id = ?',
    args: [nowIso(), feedId],
  });
}

/**
 * Slugs already in use under a prefix, for claiming a free one.
 *
 * @param {Client} db
 * @param {string} base
 * @returns {Promise<Set<string>>}
 */
export async function takenAuthorSlugs(db, base) {
  const { rows } = await db.execute({
    sql: 'select slug from authors where slug = ? or slug like ? limit 300',
    args: [base, `${base}-%`],
  });
  return new Set(rows.map((r) => String(r.slug)));
}

/**
 * @param {Client} db
 * @param {string} identityKey
 * @returns {Promise<{ id: string, slug: string } | null>}
 */
export async function authorByIdentity(db, identityKey) {
  const { rows } = await db.execute({
    sql: 'select id, slug from authors where identity_key = ? limit 1',
    args: [identityKey],
  });
  return rows[0] ? { id: String(rows[0].id), slug: String(rows[0].slug) } : null;
}

/**
 * Create an author, or fill in what a previous pass did not know.
 *
 * Existing values are kept rather than overwritten. A pass that found a name
 * and a homepage last month, and only a name today, must not blank the
 * homepage — the site being briefly unreachable is not evidence that the
 * author moved. `confidence` is the exception and takes the higher of the two,
 * since better evidence is exactly what a later pass is looking for.
 *
 * @param {Client} db
 * @param {object} author
 * @param {string} author.identityKey
 * @param {string} author.slug used only when the row is created
 * @param {string} author.name
 * @param {string} author.normName
 * @param {string} [author.bio]
 * @param {string} [author.avatarUrl]
 * @param {string} [author.siteUrl]
 * @param {string} [author.email]
 * @param {number} [author.confidence]
 * @returns {Promise<{ id: string, slug: string, created: boolean }>}
 */
export async function upsertAuthor(db, author) {
  const existing = await authorByIdentity(db, author.identityKey);
  const now = nowIso();

  if (existing) {
    await db.execute({
      sql: `update authors set
              name = case when ? <> '' then ? else name end,
              norm_name = case when ? <> '' then ? else norm_name end,
              bio = coalesce(nullif(?, ''), bio),
              avatar_url = coalesce(nullif(?, ''), avatar_url),
              site_url = coalesce(nullif(?, ''), site_url),
              email = coalesce(nullif(?, ''), email),
              confidence = max(confidence, ?),
              updated_at = ?
            where id = ?`,
      args: [
        author.name ?? '',
        author.name ?? '',
        author.normName ?? '',
        author.normName ?? '',
        author.bio ?? '',
        author.avatarUrl ?? '',
        author.siteUrl ?? '',
        author.email ?? '',
        Number(author.confidence ?? 0),
        now,
        existing.id,
      ],
    });
    return { ...existing, created: false };
  }

  const id = newId();
  await db.execute({
    sql: `insert into authors
            (id, slug, identity_key, name, norm_name, bio, avatar_url, site_url,
             email, confidence, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (identity_key) do nothing`,
    args: [
      id,
      author.slug,
      author.identityKey,
      author.name,
      author.normName,
      author.bio || null,
      author.avatarUrl || null,
      author.siteUrl || null,
      author.email || null,
      Number(author.confidence ?? 0),
      now,
      now,
    ],
  });

  // Another worker in the same pass may have inserted the same person between
  // the read above and the write just now. The conflict clause absorbs it; the
  // re-read is what tells us which id won.
  const settled = await authorByIdentity(db, author.identityKey);
  return settled ? { ...settled, created: settled.id === id } : { id, slug: author.slug, created: true };
}

/**
 * Store the places an author can be found.
 *
 * @param {Client} db
 * @param {string} authorId
 * @param {Array<{ network: string, url: string, handle?: string, source: string, verified?: boolean }>} links
 * @returns {Promise<number>} rows written, not rows offered
 */
export async function addAuthorLinks(db, authorId, links) {
  const statements = (links ?? [])
    .filter((link) => link?.url && link?.network)
    .map((link) => ({
      sql: `insert into author_links
              (id, author_id, network, url, handle, source, verified, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (author_id, url) do update set
              -- A link seen again with better provenance keeps the better one:
              -- rel="me" is a claim the author made, a footer icon is not.
              source = case when excluded.source = 'rel-me' then excluded.source else source end,
              verified = max(verified, excluded.verified)`,
      args: [
        newId(),
        authorId,
        link.network,
        link.url,
        link.handle || null,
        link.source,
        link.verified ? 1 : 0,
        nowIso(),
      ],
    }));

  return writeLinks(db, statements);
}

/**
 * Run a set of link inserts as one round trip, and count what they wrote.
 *
 * The loop these replaced spent a round trip per link, which against a network
 * database is the whole cost: an author with an email and a website was two,
 * and a feed with five accounts in its footer was five. Same statements, same
 * conflict clauses, one trip.
 *
 * An empty set makes no call at all. That is the common case on the crawl path —
 * `storeCredits` passes no site links, because finding them costs requests and
 * belongs to the slower enrichment pass — and it was previously still a call.
 *
 * @param {Client} db
 * @param {Array<{ sql: string, args: unknown[] }>} statements
 * @returns {Promise<number>} rows written, not rows offered
 */
async function writeLinks(db, statements) {
  if (statements.length === 0) return 0;

  const results = await db.batch(statements, 'write');
  return results.reduce((n, r) => n + Number(r?.rowsAffected ?? 0), 0);
}

/**
 * Store where a feed can be found, independent of who writes it.
 *
 * Deliberately a separate table from `author_links` rather than an author row
 * with a blank name. Inventing a person to hang a Mastodon account on would
 * put a fiction in the one table the site publishes as real people; saying
 * "this blog is on Mastodon" claims exactly as much as we know.
 *
 * @param {Client} db
 * @param {string} feedId
 * @param {Array<{ network: string, url: string, handle?: string, source: string, verified?: boolean }>} links
 * @returns {Promise<number>} rows written, not rows offered
 */
export async function addFeedLinks(db, feedId, links) {
  const statements = (links ?? [])
    .filter((link) => link?.url && link?.network)
    .map((link) => ({
      sql: `insert into feed_links
              (id, feed_id, network, url, handle, source, verified, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (feed_id, url) do update set
              source = case when excluded.source = 'rel-me' then excluded.source else source end,
              verified = max(verified, excluded.verified)`,
      args: [
        newId(),
        feedId,
        link.network,
        link.url,
        link.handle || null,
        link.source,
        link.verified ? 1 : 0,
        nowIso(),
      ],
    }));

  return writeLinks(db, statements);
}

/**
 * Where one feed can be found.
 *
 * @param {Client} db
 * @param {string} feedId
 * @returns {Promise<Array<{ network: string, url: string, handle: string|null, source: string, verified: boolean }>>}
 */
export async function linksForFeed(db, feedId) {
  const { rows } = await db.execute({
    sql: `select network, url, handle, source, verified
            from feed_links
           where feed_id = ?
           order by verified desc, network asc`,
    args: [feedId],
  });

  return rows.map((link) => ({
    network: String(link.network),
    url: String(link.url),
    handle: link.handle == null ? null : String(link.handle),
    source: String(link.source),
    verified: Number(link.verified) === 1,
  }));
}

/**
 * Credit an author on a feed.
 *
 * @param {Client} db
 * @param {string} feedId
 * @param {string} authorId
 * @param {{ role?: string, confidence?: number, evidence?: string }} [meta]
 * @returns {Promise<void>}
 */
export async function linkFeedAuthor(db, feedId, authorId, meta = {}) {
  await db.execute({
    sql: `insert into feed_authors (feed_id, author_id, role, confidence, evidence, created_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict (feed_id, author_id) do update set
            role = case when excluded.role = 'owner' then 'owner' else role end,
            confidence = max(confidence, excluded.confidence),
            evidence = excluded.evidence`,
    args: [
      feedId,
      authorId,
      meta.role ?? 'author',
      Number(meta.confidence ?? 0),
      meta.evidence ?? null,
      nowIso(),
    ],
  });
}

/** Columns every author read returns, so the shapes do not drift apart. */
const AUTHOR_COLUMNS = `a.id, a.slug, a.name, a.bio, a.avatar_url, a.site_url,
  a.email, a.confidence, a.created_at, a.updated_at`;

/**
 * The authors credited on one feed, with their links attached.
 *
 * @param {Client} db
 * @param {string} feedId
 * @returns {Promise<Array<object>>}
 */
export async function authorsForFeed(db, feedId) {
  const { rows } = await db.execute({
    sql: `select ${AUTHOR_COLUMNS}, fa.role, fa.confidence as feed_confidence
            from feed_authors fa
            join authors a on a.id = fa.author_id
           where fa.feed_id = ?
           order by fa.role = 'owner' desc, fa.confidence desc, a.name asc`,
    args: [feedId],
  });

  return withLinks(db, /** @type {any} */ (rows));
}

/**
 * The same, for a page of feeds at once.
 *
 * A listing that called `authorsForFeed` per row would issue one query per
 * feed on the page; this is the two-query form of the same answer.
 *
 * @param {Client} db
 * @param {string[]} feedIds
 * @returns {Promise<Map<string, Array<object>>>} keyed by feed id
 */
export async function authorsForFeeds(db, feedIds) {
  const ids = [...new Set(feedIds.map(String))].filter(Boolean);
  if (ids.length === 0) return new Map();

  const { rows } = await db.execute({
    sql: `select fa.feed_id, ${AUTHOR_COLUMNS}, fa.role
            from feed_authors fa
            join authors a on a.id = fa.author_id
           where fa.feed_id in (${ids.map(() => '?').join(',')})
           order by fa.role = 'owner' desc, fa.confidence desc`,
    args: ids,
  });

  /** @type {Map<string, Array<object>>} */
  const byFeed = new Map();
  for (const row of rows) {
    const key = String(row.feed_id);
    const list = byFeed.get(key) ?? [];
    list.push(row);
    byFeed.set(key, list);
  }

  return byFeed;
}

/**
 * One author's public record: their details, their links and their feeds.
 *
 * @param {Client} db
 * @param {string} slug
 * @returns {Promise<object|null>}
 */
export async function authorBySlug(db, slug) {
  const { rows } = await db.execute({
    sql: `select ${AUTHOR_COLUMNS} from authors a where a.slug = ? limit 1`,
    args: [slug],
  });
  if (!rows[0]) return null;

  const [author] = await withLinks(db, /** @type {any} */ (rows));

  const feeds = await db.execute({
    // `f.id` rides along so the caller can ask what these feeds published
    // without a second lookup -- see `postsByAuthor`, which is bounded by
    // exactly these ids rather than searching feed_items for an author.
    sql: `select f.id, f.slug, f.title, f.site_url, f.image_url, f.kind, f.description,
                 fa.role, f.item_count
            from feed_authors fa
            join feeds f on f.id = fa.feed_id
           where fa.author_id = ?
           order by f.item_count desc
           limit 100`,
    args: [author.id],
  });

  return { ...author, feeds: feeds.rows };
}

/**
 * A page of authors, most complete first.
 *
 * Ordered by confidence and then by how many links they have, because an
 * author with a homepage, a Mastodon and a Linktree is a more useful directory
 * entry than one with a name and nothing else — and the whole point of the
 * page is to be able to reach people.
 *
 * @param {Client} db
 * @param {{ limit?: number, offset?: number, minConfidence?: number, network?: string, query?: string }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function listAuthors(db, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 200);
  const offset = Math.max(Number(opts.offset ?? 0), 0);
  const minConfidence = Number(opts.minConfidence ?? 0);

  const where = ['a.confidence >= ?'];
  const args = [minConfidence];

  if (opts.network) {
    where.push('exists (select 1 from author_links l where l.author_id = a.id and l.network = ?)');
    args.push(String(opts.network));
  }
  if (opts.query) {
    where.push('a.norm_name like ?');
    args.push(`%${String(opts.query).toLowerCase().trim()}%`);
  }

  const { rows } = await db.execute({
    sql: `select ${AUTHOR_COLUMNS},
                 (select count(*) from author_links l where l.author_id = a.id) as link_count,
                 (select count(*) from feed_authors fa where fa.author_id = a.id) as feed_count
            from authors a
           where ${where.join(' and ')}
           order by a.confidence desc, link_count desc, a.name asc
           limit ? offset ?`,
    args: [...args, limit, offset],
  });

  return withLinks(db, /** @type {any} */ (rows));
}

/**
 * @param {Client} db
 * @param {{ minConfidence?: number }} [opts]
 * @returns {Promise<number>}
 */
export async function countAuthors(db, opts = {}) {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from authors where confidence >= ?',
    args: [Number(opts.minConfidence ?? 0)],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Author pages worth listing in the sitemap.
 *
 * Ordered by confidence rather than by name, because the list is capped: if
 * the directory ever holds more authors than one sitemap file may carry, the
 * ones that get dropped should be the guesses and not the people we are sure
 * about.
 *
 * @param {Client} db
 * @param {number} limit
 * @param {number} [minConfidence]
 * @returns {Promise<Array<{ slug: string, updated_at: string }>>}
 */
export async function authorsForSitemap(db, limit, minConfidence = 0.6) {
  const { rows } = await db.execute({
    sql: `select slug, updated_at from authors
           where confidence >= ?
           order by confidence desc, updated_at desc
           limit ?`,
    args: [minConfidence, limit],
  });

  return /** @type {any} */ (rows);
}

/**
 * How far the enrichment pass has got, and what it has found.
 *
 * @param {Client} db
 * @returns {Promise<{ authors: number, links: number, feedsChecked: number, feedsWithAuthor: number, reachable: number }>}
 */
export async function authorStats(db, opts = {}) {
  const one = async (sql) => Number((await db.execute(sql)).rows[0]?.n ?? 0);
  const floor = async (sql) =>
    Number((await db.execute({ sql, args: [Number(opts.minConfidence ?? 0)] })).rows[0]?.n ?? 0);

  return {
    // Counted against the same floor the caller publishes at, or every author
    // when none is given. The two must agree: a page saying "9 of 6 can be
    // reached" is what happens when the numerator ignores a filter the
    // denominator applies.
    authors: await floor('select count(*) as n from authors where confidence >= ?'),
    links: await one('select count(*) as n from author_links'),
    feedsChecked: await one('select count(*) as n from feeds where authors_checked_at is not null'),
    feedsWithAuthor: await one('select count(distinct feed_id) as n from feed_authors'),
    // The number that matters for outreach: authors with at least one way to
    // contact them, rather than authors whose name we happen to know.
    //
    // Any link counts, not a shortlist of the messaging ones. An email is the
    // easiest thing to act on, but a Mastodon account, a LinkedIn profile or
    // just the person's own site with a contact form on it are all ways to
    // reach somebody — and counting only the first few made the directory look
    // far less useful than it is.
    reachable: await floor(
      `select count(distinct a.id) as n from authors a
         join author_links l on l.author_id = a.id
        where a.confidence >= ?`,
    ),
    // Feeds with somewhere to write to, whether or not a person is named. The
    // wider number, and the honest one for "how much of this directory could
    // we contact": a blog with a Mastodon in the footer and no byline is
    // reachable even though nobody is.
    feedsWithLinks: await one('select count(distinct feed_id) as n from feed_links'),
  };
}

/**
 * Attach each author's links to their row.
 *
 * @param {Client} db
 * @param {Array<any>} rows
 * @returns {Promise<Array<any>>}
 */
async function withLinks(db, rows) {
  const ids = [...new Set(rows.map((r) => String(r.id)))];
  if (ids.length === 0) return [];

  const { rows: links } = await db.execute({
    sql: `select author_id, network, url, handle, source, verified
            from author_links
           where author_id in (${ids.map(() => '?').join(',')})
           order by verified desc, network asc`,
    args: ids,
  });

  /** @type {Map<string, Array<any>>} */
  const byAuthor = new Map();
  for (const link of links) {
    const key = String(link.author_id);
    const list = byAuthor.get(key) ?? [];
    list.push({
      network: String(link.network),
      url: String(link.url),
      handle: link.handle == null ? null : String(link.handle),
      source: String(link.source),
      verified: Number(link.verified) === 1,
    });
    byAuthor.set(key, list);
  }

  return rows.map((row) => ({ ...row, links: byAuthor.get(String(row.id)) ?? [] }));
}

/**
 * Whether this feed has anybody filed against it yet.
 *
 * One indexed existence check, and it exists to stop four write transactions.
 *
 * `storeCredits` runs inside every crawl, and on a re-crawl of an unchanged
 * feed it re-wrote the same author three times over — an `update authors` that
 * coalesced every column onto the value already there, an `insert ... on
 * conflict` into feed_authors, and another into author_links. Instrumenting a
 * crawl against a local database showed a re-crawl costing 7 round trips of
 * which **4 were write transactions, and 3 of those changed nothing**.
 *
 * That is expensive in the one currency this database is short of. A write
 * transaction here costs ~370ms and they serialize per database, so three
 * pointless ones per feed is most of the crawler's throughput ceiling; a read
 * costs ~100ms and does not block anyone.
 *
 * @param {Client} db
 * @param {string} feedId
 * @returns {Promise<boolean>}
 */
export async function feedHasAuthors(db, feedId) {
  const { rows } = await db.execute({
    sql: 'select 1 as x from feed_authors where feed_id = ? limit 1',
    args: [feedId],
  });
  return rows.length > 0;
}

/* ------------------------------------------------- credits, as one write */

/**
 * The author writes a crawl needs, as statements for a single batch.
 *
 * Storing one credit used to cost four write transactions -- a read for the
 * identity, another inside `upsertAuthor`, the insert or update itself, a
 * re-read to settle concurrent writers, then `linkFeedAuthor` and
 * `addAuthorLinks` on top. That was measured by instrumenting a real crawl: a
 * first crawl of a 150-item feed spent 10 round trips and 5 write transactions,
 * and 3 of the 5 were these.
 *
 * On this database a write transaction costs ~370ms and they serialize per
 * database, so write transactions per feed is the crawler's entire throughput
 * ceiling -- an empty write transaction and a hundred-row one measured the
 * same. Collapsing these into one batch is worth more than any amount of making
 * the statements themselves cheaper.
 *
 * **The author id is resolved in SQL rather than read back.** That is what makes
 * one batch possible: the feed_authors row needs the id the upsert decides, and
 * the obvious way to get it is to insert, read it back, then link -- three round
 * trips that cannot be merged because the middle one is a read. Written as
 * `insert into feed_authors (...) select ?, id, ... from authors where
 * identity_key = ?`, the id is looked up inside the same transaction, after the
 * upsert above it has run. It is also *safer* than the round trip it replaces:
 * a concurrent writer that wins the race changes which id the select finds and
 * the link still lands on the right person, where reading an id into JS and
 * binding it later can attach a link to the loser of the race.
 *
 * Every statement carries a WHERE guard so that re-storing an unchanged credit
 * writes no rows. That buys no latency -- the transaction happens either way --
 * but rows written is a metered resource on this account.
 *
 * @param {object} input
 * @param {string} input.feedId
 * @param {string} input.identityKey
 * @param {string} input.slug slug to use if this person is new; ignored if not
 * @param {object} input.person the merged credit
 * @param {Array<object>} [input.authorLinks] accounts to file under the person
 * @param {Array<object>} [input.feedLinks] accounts to file under the feed
 * @returns {Array<{ sql: string, args: unknown[] }>} in dependency order
 */
export function creditStatements({ feedId, identityKey, slug, person, authorLinks = [], feedLinks = [] }) {
  const now = nowIso();
  const statements = [];

  // One statement for both the create and the update path. `do update` rather
  // than `do nothing`, so a person we already know gains whatever this crawl
  // learned about them; the slug is deliberately absent from the SET list,
  // because a slug is a permanent address and re-deriving it from a changed
  // display name would break every link to that author's page.
  statements.push({
    sql: `insert into authors
            (id, slug, identity_key, name, norm_name, bio, avatar_url, site_url,
             email, confidence, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (identity_key) do update set
            name = case when excluded.name <> '' then excluded.name else authors.name end,
            norm_name = case when excluded.norm_name <> '' then excluded.norm_name else authors.norm_name end,
            bio = coalesce(nullif(excluded.bio, ''), authors.bio),
            avatar_url = coalesce(nullif(excluded.avatar_url, ''), authors.avatar_url),
            site_url = coalesce(nullif(excluded.site_url, ''), authors.site_url),
            email = coalesce(nullif(excluded.email, ''), authors.email),
            confidence = max(authors.confidence, excluded.confidence),
            updated_at = excluded.updated_at
          where (excluded.name <> '' and authors.name <> excluded.name)
             or (authors.bio is null and excluded.bio is not null)
             or (authors.avatar_url is null and excluded.avatar_url is not null)
             or (authors.site_url is null and excluded.site_url is not null)
             or (authors.email is null and excluded.email is not null)
             or authors.confidence < excluded.confidence`,
    args: [
      newId(),
      slug,
      identityKey,
      person.name,
      person.normName ?? '',
      person.bio || null,
      person.avatarUrl || null,
      person.siteUrl || null,
      person.email || null,
      Number(person.confidence ?? 0),
      now,
      now,
    ],
  });

  statements.push({
    sql: `insert into feed_authors (feed_id, author_id, role, confidence, evidence, created_at)
          select ?, id, ?, ?, ?, ? from authors where identity_key = ?
          on conflict (feed_id, author_id) do update set
            role = case when excluded.role = 'owner' then 'owner' else feed_authors.role end,
            confidence = max(feed_authors.confidence, excluded.confidence),
            evidence = excluded.evidence
          where (feed_authors.role <> 'owner' and excluded.role = 'owner')
             or feed_authors.confidence < excluded.confidence
             or feed_authors.evidence is not excluded.evidence`,
    args: [
      feedId,
      person.role ?? 'author',
      Number(person.confidence ?? 0),
      person.evidence ?? null,
      now,
      identityKey,
    ],
  });

  for (const link of authorLinks) {
    if (!link?.url || !link?.network) continue;
    statements.push({
      sql: `insert into author_links (id, author_id, network, url, handle, source, verified, created_at)
            select ?, id, ?, ?, ?, ?, ?, ? from authors where identity_key = ?
            on conflict (author_id, url) do update set
              source = case when excluded.source = 'rel-me' then excluded.source else author_links.source end,
              verified = max(author_links.verified, excluded.verified)
            where (author_links.source <> 'rel-me' and excluded.source = 'rel-me')
               or author_links.verified < excluded.verified`,
      args: [
        newId(),
        link.network,
        link.url,
        link.handle || null,
        link.source,
        link.verified ? 1 : 0,
        now,
        identityKey,
      ],
    });
  }

  statements.push(...feedLinkStatements(feedId, feedLinks));
  return statements;
}

/**
 * The feed's own accounts, as statements. No author id to resolve, so these are
 * plain inserts -- split out only so they can join the same batch.
 *
 * @param {string} feedId
 * @param {Array<object>} links
 * @returns {Array<{ sql: string, args: unknown[] }>}
 */
export function feedLinkStatements(feedId, links) {
  return (links ?? [])
    .filter((link) => link?.url && link?.network)
    .map((link) => ({
      sql: `insert into feed_links (id, feed_id, network, url, handle, source, verified, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (feed_id, url) do update set
              source = case when excluded.source = 'rel-me' then excluded.source else feed_links.source end,
              verified = max(feed_links.verified, excluded.verified)
            where (feed_links.source <> 'rel-me' and excluded.source = 'rel-me')
               or feed_links.verified < excluded.verified`,
      args: [
        newId(),
        feedId,
        link.network,
        link.url,
        link.handle || null,
        link.source,
        link.verified ? 1 : 0,
        nowIso(),
      ],
    }));
}

/**
 * What one person has published lately, across every feed credited to them.
 *
 * Bounded by the author's own feeds rather than searched for, which is the
 * whole reason this is safe to put on a page. The obvious spelling joins
 * feed_items to feeds to feed_authors, and 0017 established what that costs
 * here: a feed_items-to-feeds aggregate measured **215 seconds** against
 * production. This takes the handful of feed ids the caller already has —
 * an author writes one or two blogs, not thousands — and reads them straight
 * off `feed_items_feed_pub_idx`, which is the index the feed page itself uses.
 *
 * Capped at a small number of feeds for the same reason. A person credited on
 * hundreds of feeds is a mis-attribution rather than a prolific writer, and the
 * page should degrade to showing some of their work rather than to a query that
 * takes a minute.
 *
 * @param {Client} db
 * @param {string[]} feedIds
 * @param {number} [limit] posts
 * @returns {Promise<object[]>}
 */
export async function postsByAuthor(db, feedIds, limit = 12) {
  const ids = (feedIds ?? []).map((id) => String(id)).filter(Boolean).slice(0, 20);
  if (ids.length === 0) return [];

  const marks = ids.map(() => '?').join(',');
  const { rows } = await db.execute({
    // `summary` and the audio duration are here for the author's own feed
    // (see lib/authorRiver.js), which renders the same rows as a document
    // rather than as a list of links. The page ignores both.
    sql: `select i.guid, i.title, i.url, i.summary, i.published_at, i.image_url,
                 i.audio_url, i.audio_type, i.audio_seconds,
                 f.slug as feed_slug, f.title as feed_title, f.category, f.feed_url
          from feed_items i
          join feeds f on f.id = i.feed_id
          where i.feed_id in (${marks})
          order by i.published_at desc nulls last, i.created_at desc
          limit ?`,
    args: [...ids, limit],
  });

  return rows;
}

/**
 * How many of one author's feeds a river reads.
 *
 * The same bound `ALERT_AUTHOR_FEEDS` puts on the alert query, for the same
 * reason: somebody credited on more feeds than this is a mis-merge rather than
 * a polymath, and either way the page should not pay for it.
 */
export const RIVER_AUTHOR_FEEDS = 20;

/**
 * What one person has published lately, by their id.
 *
 * The sibling of `postsByAuthor`, which takes feed ids because its caller — the
 * author page — has already loaded them. The river has not: it holds a list of
 * follows and would otherwise have to fetch every author in full simply to
 * learn which feeds are theirs, which is one round trip per followed person
 * before a single post has been read.
 *
 * @param {Client} db
 * @param {string} authorId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function postsByAuthorId(db, authorId, limit = 60) {
  const { rows } = await db.execute({
    sql: `with picked as (
            select fa.feed_id from feed_authors fa
            join feeds f on f.id = fa.feed_id and f.status <> 'dead'
            where fa.author_id = ?
            limit ?
          )
          select i.guid, i.title, i.url, i.summary, i.published_at, i.created_at,
                 i.image_url, i.audio_url, i.audio_type, i.audio_seconds, i.cluster_key,
                 f.slug as feed_slug, f.title as feed_title, f.category, f.feed_url
          from feed_items i
          join feeds f on f.id = i.feed_id
          where i.feed_id in (select feed_id from picked)
          order by i.published_at desc nulls last, i.created_at desc
          limit ?`,
    args: [authorId, RIVER_AUTHOR_FEEDS, limit],
  });

  return rows;
}

/* ------------------------------------------------------------------ *
 * Bought searches
 * ------------------------------------------------------------------ */

/**
 * The people it would be worth buying a search for.
 *
 * The gate is mean because the budget is small. What it selects for is the
 * person we are confident *is* a person, who writes here, and whom nobody can
 * currently contact — which is the only case where a paid query buys something
 * the free sources could not.
 *
 * Ordered by how much they publish, so a limited budget is spent on the
 * publishers a reader is most likely to want to reach.
 *
 * Anyone searched for already is excluded outright rather than re-searched on a
 * schedule: a second query for somebody the web did not know about the first
 * time is the easiest way to spend a month's credits on nothing.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @param {number} [minConfidence] the floor the caller publishes at
 * @returns {Promise<object[]>}
 */
export async function authorsWithoutContact(db, limit = 10, minConfidence = 0.8) {
  const { rows } = await db.execute({
    sql: `select a.id, a.slug, a.name, a.site_url as site, a.confidence,
                 count(distinct fa.feed_id) as feed_count
            from authors a
            join feed_authors fa on fa.author_id = a.id
           where a.confidence >= ?
             and not exists (select 1 from author_links l where l.author_id = a.id)
             and not exists (select 1 from author_searches s where s.author_id = a.id)
             -- A single word is not a searchable name: it returns the world.
             and instr(trim(a.name), ' ') > 0
           group by a.id
           order by feed_count desc, a.confidence desc
           limit ?`,
    args: [minConfidence, limit],
  });

  return rows;
}

/**
 * Write down what a search cost, whether or not it found anything.
 *
 * @param {Client} db
 * @param {{ authorId: string|null, queries: number, found: number }} spend
 * @returns {Promise<void>}
 */
export async function recordAuthorSearch(db, spend) {
  await db.execute({
    sql: `insert into author_searches (id, author_id, at, queries, found)
          values (?, ?, ?, ?, ?)`,
    args: [
      newId(),
      spend.authorId ?? null,
      nowIso(),
      Math.max(0, Math.floor(Number(spend.queries) || 0)),
      Math.max(0, Math.floor(Number(spend.found) || 0)),
    ],
  });
}

/**
 * Credits spent since a moment, which is how much of the budget is gone.
 *
 * @param {Client} db
 * @param {string} since ISO 8601
 * @returns {Promise<number>}
 */
export async function searchSpendSince(db, since) {
  const { rows } = await db.execute({
    sql: 'select coalesce(sum(queries), 0) as spent from author_searches where at >= ?',
    args: [String(since)],
  });

  return Number(rows[0]?.spent ?? 0);
}

/**
 * The start of the current billing period.
 *
 * The provider's month does not begin on the first: ValueSERP resets this
 * account's allowance on the **13th**, so a budget counted per calendar month
 * would let the allowance be spent twice across a reset and refuse spending
 * that is actually available just after one.
 *
 * @param {Date} [now]
 * @param {number} [resetDay]
 * @returns {string} ISO 8601
 */
export function billingPeriodStart(now = new Date(), resetDay = 13) {
  const at = new Date(now.getTime());
  const start = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), resetDay, 0, 0, 0, 0),
  );

  // Before this month's reset day, the period began last month.
  if (at.getTime() < start.getTime()) start.setUTCMonth(start.getUTCMonth() - 1);

  return start.toISOString();
}
