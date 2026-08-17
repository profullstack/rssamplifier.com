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
  let written = 0;

  for (const link of links) {
    if (!link?.url || !link?.network) continue;

    const { rowsAffected } = await db.execute({
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
    });
    written += Number(rowsAffected ?? 0);
  }

  return written;
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
    sql: `select f.slug, f.title, f.site_url, f.image_url, f.kind, f.description,
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
 * How far the enrichment pass has got, and what it has found.
 *
 * @param {Client} db
 * @returns {Promise<{ authors: number, links: number, feedsChecked: number, feedsWithAuthor: number, reachable: number }>}
 */
export async function authorStats(db) {
  const one = async (sql) => Number((await db.execute(sql)).rows[0]?.n ?? 0);

  return {
    authors: await one('select count(*) as n from authors'),
    links: await one('select count(*) as n from author_links'),
    feedsChecked: await one('select count(*) as n from feeds where authors_checked_at is not null'),
    feedsWithAuthor: await one('select count(distinct feed_id) as n from feed_authors'),
    // The number that matters for outreach: authors with at least one way to
    // contact them, rather than authors whose name we happen to know.
    reachable: await one(
      `select count(distinct a.id) as n from authors a
         join author_links l on l.author_id = a.id
        where l.network in ('email', 'fediverse', 'bluesky', 'twitter', 'linkedin', 'linktree')`,
    ),
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
