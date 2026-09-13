import { nowIso } from './client.js';

/**
 * The author's own corrections to their generated OpenProfile.md, and the
 * claim that makes them theirs.
 *
 * The generated file is built from `authors`, `author_links`, `feed_authors`
 * and the feeds themselves (see apps/web/src/lib/openprofile.js). This table
 * holds only what a person changed on top of that and who they are, so a
 * re-crawl that finds a new link still reaches the file, and a correction the
 * person made still wins over it.
 *
 * @typedef {import('@libsql/client').Client} Client
 * @typedef {{
 *   author_id: string,
 *   overrides: Record<string, any>,
 *   public: boolean,
 *   owner_user_id: string|null,
 *   owner_principal: string|null,
 *   claimed_at: string|null,
 *   claim_method: string|null,
 *   updated_at: string,
 * }} AuthorProfile
 */

const COLUMNS = `author_id, overrides, public, owner_user_id, owner_principal,
  claimed_at, claim_method, updated_at`;

/**
 * @param {any} row
 * @returns {AuthorProfile}
 */
function shape(row) {
  let overrides = {};
  try {
    overrides = JSON.parse(String(row.overrides ?? '{}')) ?? {};
  } catch {
    overrides = {};
  }
  return {
    author_id: String(row.author_id),
    overrides,
    public: Number(row.public ?? 1) === 1,
    owner_user_id: row.owner_user_id == null ? null : String(row.owner_user_id),
    owner_principal: row.owner_principal == null ? null : String(row.owner_principal),
    claimed_at: row.claimed_at == null ? null : String(row.claimed_at),
    claim_method: row.claim_method == null ? null : String(row.claim_method),
    updated_at: String(row.updated_at),
  };
}

/**
 * The profile row for an author, or null when nobody has touched it.
 *
 * @param {Client} db
 * @param {string} authorId
 * @returns {Promise<AuthorProfile|null>}
 */
export async function profileForAuthor(db, authorId) {
  const { rows } = await db.execute({
    sql: `select ${COLUMNS} from author_profiles where author_id = ? limit 1`,
    args: [authorId],
  });
  return rows[0] ? shape(rows[0]) : null;
}

/**
 * Write the overlay and the public switch. Creates the row when there is none.
 *
 * The caller merges: this stores what it is handed, so an edit over the API,
 * the CLI, the MCP tool and the web form all go through one merge in one
 * place (the route) and one write here.
 *
 * @param {Client} db
 * @param {string} authorId
 * @param {{ overrides?: Record<string, any>, public?: boolean }} patch
 * @returns {Promise<AuthorProfile>}
 */
export async function saveProfile(db, authorId, patch) {
  const now = nowIso();
  const existing = await profileForAuthor(db, authorId);
  const overrides = patch.overrides ?? existing?.overrides ?? {};
  const isPublic = patch.public ?? existing?.public ?? true;

  await db.execute({
    sql: `insert into author_profiles (author_id, overrides, public, updated_at)
          values (?, ?, ?, ?)
          on conflict (author_id) do update set
            overrides = excluded.overrides,
            public = excluded.public,
            updated_at = excluded.updated_at`,
    args: [authorId, JSON.stringify(overrides), isPublic ? 1 : 0, now],
  });

  return /** @type {AuthorProfile} */ (await profileForAuthor(db, authorId));
}

/**
 * Record who this profile belongs to.
 *
 * A second claim by the same person is a no-op; a claim by somebody else on a
 * profile that already has an owner is refused by the caller, not here, because
 * the caller is the one that verified the claim and knows why it is allowed
 * (an admin taking a profile over, for instance).
 *
 * @param {Client} db
 * @param {string} authorId
 * @param {{ userId?: string|null, principal?: string|null, method: string }} claim
 * @returns {Promise<AuthorProfile>}
 */
export async function claimProfile(db, authorId, claim) {
  const now = nowIso();
  await db.execute({
    sql: `insert into author_profiles (author_id, overrides, public, owner_user_id, owner_principal, claimed_at, claim_method, updated_at)
          values (?, '{}', 1, ?, ?, ?, ?, ?)
          on conflict (author_id) do update set
            owner_user_id = coalesce(excluded.owner_user_id, author_profiles.owner_user_id),
            owner_principal = coalesce(excluded.owner_principal, author_profiles.owner_principal),
            claimed_at = coalesce(author_profiles.claimed_at, excluded.claimed_at),
            claim_method = coalesce(author_profiles.claim_method, excluded.claim_method),
            updated_at = excluded.updated_at`,
    args: [authorId, claim.userId ?? null, claim.principal ?? null, now, claim.method, now],
  });
  return /** @type {AuthorProfile} */ (await profileForAuthor(db, authorId));
}

/**
 * The profiles an account owns, for the account page.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<Array<{ author_id: string, slug: string, name: string, claimed_at: string|null }>>}
 */
export async function profilesForUser(db, userId) {
  const { rows } = await db.execute({
    sql: `select p.author_id, a.slug, a.name, p.claimed_at
            from author_profiles p
            join authors a on a.id = p.author_id
           where p.owner_user_id = ?
           order by p.claimed_at desc`,
    args: [userId],
  });
  return /** @type {any} */ (rows);
}

/**
 * The topics of several feeds at once, strongest first per feed, as
 * `feed_id -> [{ keyword, source }]`. What the Topics of a profile and the
 * `Topics` key of each Broadcast group are made of. `source` rides along
 * because the two differ: 'category' is the publisher's own tag and
 * 'content' is a phrase counted out of their text, and a show's Broadcast
 * lists only the first kind.
 *
 * @param {Client} db
 * @param {string[]} feedIds
 * @param {number} [perFeed]
 * @returns {Promise<Map<string, Array<{ keyword: string, source: string }>>>}
 */
export async function keywordsForFeeds(db, feedIds, perFeed = 8) {
  const out = new Map();
  if (feedIds.length === 0) return out;
  const { rows } = await db.execute({
    sql: `select feed_id, keyword, source, count from feed_keywords
           where feed_id in (${feedIds.map(() => '?').join(',')})
           order by feed_id, case source when 'category' then 0 else 1 end, count desc, keyword asc`,
    args: feedIds,
  });
  for (const row of rows) {
    const id = String(row.feed_id);
    const list = out.get(id) ?? [];
    if (list.length < perFeed) list.push({ keyword: String(row.keyword), source: String(row.source) });
    out.set(id, list);
  }
  return out;
}

/**
 * Every author with a public profile, newest change first, for a directory
 * that pulls profiles (nichedb): keyset paging over (updated_at, id), where
 * updated_at is the later of the author row's and the overlay's, so an edit
 * and a re-crawl both surface. `since` narrows to changes at or after a stamp.
 *
 * Only authors above the site's own confidence floor: a weak attribution
 * the site itself does not list is not a person to publish elsewhere.
 *
 * @param {Client} db
 * @param {{ since?: string|null, limit?: number, cursor?: { updatedAt: string, id: string }|null, minConfidence?: number }} [opts]
 * @returns {Promise<Array<{ id: string, slug: string, name: string, site_url: string|null, updated_at: string, urls: string[] }>>}
 */
export async function listOpenProfiles(db, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit ?? 100) || 100, 1), 500);
  const minConfidence = Number(opts.minConfidence ?? 0.6);
  const stamp = 'max(a.updated_at, coalesce(p.updated_at, a.updated_at))';
  const where = ['a.confidence >= ?', 'coalesce(p.public, 1) = 1'];
  const args = [minConfidence];
  if (opts.since) {
    where.push(`${stamp} >= ?`);
    args.push(opts.since);
  }
  if (opts.cursor) {
    where.push(`(${stamp} < ? or (${stamp} = ? and a.id < ?))`);
    args.push(opts.cursor.updatedAt, opts.cursor.updatedAt, opts.cursor.id);
  }
  const { rows } = await db.execute({
    sql: `select a.id, a.slug, a.name, a.site_url, ${stamp} as updated_at
            from authors a
            left join author_profiles p on p.author_id = a.id
           where ${where.join(' and ')}
           order by updated_at desc, a.id desc
           limit ?`,
    args: [...args, limit],
  });
  const ids = rows.map((r) => String(r.id));
  /** @type {Map<string, string[]>} */
  const urls = new Map();
  if (ids.length) {
    const links = await db.execute({
      sql: `select author_id, url from author_links
             where author_id in (${ids.map(() => '?').join(',')}) and network <> 'email'
             order by verified desc, network asc`,
      args: ids,
    });
    for (const l of links.rows) {
      const list = urls.get(String(l.author_id)) ?? [];
      list.push(String(l.url));
      urls.set(String(l.author_id), list);
    }
  }
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    site_url: r.site_url == null ? null : String(r.site_url),
    updated_at: String(r.updated_at),
    urls: urls.get(String(r.id)) ?? [],
  }));
}
