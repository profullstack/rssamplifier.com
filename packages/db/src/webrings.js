import { nowIso } from './client.js';
import { topicLabelSql } from './topicLabel.js';

/**
 * Webrings (logicsrc.com/openwebring): rings and their ordered members.
 *
 * Every statement about rings lives here. The routes and the poller pass
 * call these and nothing else, so the one rule the schema depends on, that a
 * member's position is assigned once and never rewritten, is enforced in one
 * place: `seedTopicRing` appends and `recordCheck` never touches position.
 *
 * Every optional value reaching a bound parameter is coerced with `?? null`.
 * The remote libSQL client refuses to bind `undefined` and a file: database
 * binds it as null without complaint, so a missing key passes every local
 * test and fails on the wire with no column named (PR #141).
 *
 * @typedef {import('@libsql/client').Client} Client
 * @typedef {{
 *   slug: string,
 *   title: string,
 *   description: string|null,
 *   kind: 'topic'|'curated',
 *   topic_slug: string|null,
 *   accepts: string[]|null,
 *   public: boolean,
 *   created_at: string,
 *   updated_at: string,
 *   member_count: number,
 *   active_count: number,
 *   updated: string,
 * }} Ring
 * @typedef {{
 *   ring_slug: string,
 *   feed_id: string,
 *   member_slug: string,
 *   position: number,
 *   site_url: string,
 *   made_by: 'human'|'ai'|'both'|null,
 *   made_by_source: 'descriptor'|'owner'|'admin'|null,
 *   disclosure: string|null,
 *   descriptor_url: string|null,
 *   status: 'active'|'inactive'|'pending',
 *   checked_at: string|null,
 *   joined_at: string,
 *   title: string,
 *   feed_url: string,
 *   language: string|null,
 * }} RingMember
 */

/** The made_by values a member may declare. */
export const MADE_BY = ['human', 'ai', 'both'];

/** Who may have set made_by, in order of authority. */
export const MADE_BY_SOURCES = ['descriptor', 'owner', 'admin'];

/** The member states. */
export const MEMBER_STATUS = ['active', 'inactive', 'pending'];

/**
 * Ring columns plus the counts and the `updated` stamp every listing wants.
 *
 * `updated` is computed rather than stored: the verification pass writes a
 * row per member, and touching the ring on every one would double its
 * writes for a stamp that a `max()` over the members answers exactly.
 */
const RING_SELECT = `
  select r.slug, r.title, r.description, r.kind, r.topic_slug, r.accepts, r.public,
         r.created_at, r.updated_at,
         (select count(*) from ring_members m where m.ring_slug = r.slug) as member_count,
         (select count(*) from ring_members m where m.ring_slug = r.slug and m.status = 'active') as active_count,
         max(r.updated_at,
             coalesce((select max(max(m.joined_at, coalesce(m.checked_at, ''))) from ring_members m where m.ring_slug = r.slug), '')
         ) as updated
    from rings r`;

/**
 * @param {any} row
 * @returns {Ring}
 */
function shapeRing(row) {
  let accepts = null;
  if (row.accepts != null) {
    try {
      const parsed = JSON.parse(String(row.accepts));
      accepts = Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      accepts = null;
    }
  }
  return {
    slug: String(row.slug),
    title: String(row.title),
    description: row.description == null ? null : String(row.description),
    kind: /** @type {'topic'|'curated'} */ (String(row.kind)),
    topic_slug: row.topic_slug == null ? null : String(row.topic_slug),
    accepts,
    public: Number(row.public ?? 1) === 1,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    member_count: Number(row.member_count ?? 0),
    active_count: Number(row.active_count ?? 0),
    updated: String(row.updated || row.updated_at),
  };
}

/**
 * @param {any} row
 * @returns {RingMember}
 */
function shapeMember(row) {
  return {
    ring_slug: String(row.ring_slug),
    feed_id: String(row.feed_id),
    member_slug: String(row.member_slug),
    position: Number(row.position),
    site_url: String(row.site_url),
    made_by: row.made_by == null ? null : /** @type {any} */ (String(row.made_by)),
    made_by_source: row.made_by_source == null ? null : /** @type {any} */ (String(row.made_by_source)),
    disclosure: row.disclosure == null ? null : String(row.disclosure),
    descriptor_url: row.descriptor_url == null ? null : String(row.descriptor_url),
    status: /** @type {any} */ (String(row.status)),
    checked_at: row.checked_at == null ? null : String(row.checked_at),
    joined_at: String(row.joined_at),
    title: String(row.title ?? row.member_slug),
    feed_url: String(row.feed_url ?? ''),
    language: row.language == null ? null : String(row.language),
  };
}

/**
 * Every public ring, most members first.
 *
 * @param {Client} db
 * @param {{ includePrivate?: boolean }} [opts]
 * @returns {Promise<Ring[]>}
 */
export async function listRings(db, opts = {}) {
  const { rows } = await db.execute({
    sql: `${RING_SELECT}
          ${opts.includePrivate ? '' : 'where r.public = 1'}
          order by member_count desc, r.slug asc`,
    args: [],
  });
  return rows.map(shapeRing);
}

/**
 * One ring, or null.
 *
 * @param {Client} db
 * @param {string} slug
 * @returns {Promise<Ring|null>}
 */
export async function ringBySlug(db, slug) {
  const { rows } = await db.execute({
    sql: `${RING_SELECT} where r.slug = ? limit 1`,
    args: [slug],
  });
  return rows[0] ? shapeRing(rows[0]) : null;
}

/**
 * A ring's members in ring order, every status included.
 *
 * Joined to the feed for its title, feed URL and language, which the ring
 * file and the OPML both want and which are the feed's to change.
 *
 * @param {Client} db
 * @param {string} ringSlug
 * @returns {Promise<RingMember[]>}
 */
export async function membersOf(db, ringSlug) {
  const { rows } = await db.execute({
    sql: `select m.ring_slug, m.feed_id, m.member_slug, m.position, m.site_url, m.made_by,
                 m.made_by_source, m.disclosure, m.descriptor_url, m.status, m.checked_at,
                 m.joined_at, f.title, f.feed_url, f.language
            from ring_members m
            join feeds f on f.id = m.feed_id
           where m.ring_slug = ?
           order by m.position asc`,
    args: [ringSlug],
  });
  return rows.map(shapeMember);
}

/**
 * One member by its slug in the ring, or null.
 *
 * @param {Client} db
 * @param {string} ringSlug
 * @param {string} memberSlug
 * @returns {Promise<RingMember|null>}
 */
export async function memberBySlug(db, ringSlug, memberSlug) {
  const { rows } = await db.execute({
    sql: `select m.ring_slug, m.feed_id, m.member_slug, m.position, m.site_url, m.made_by,
                 m.made_by_source, m.disclosure, m.descriptor_url, m.status, m.checked_at,
                 m.joined_at, f.title, f.feed_url, f.language
            from ring_members m
            join feeds f on f.id = m.feed_id
           where m.ring_slug = ? and m.member_slug = ?
           limit 1`,
    args: [ringSlug, memberSlug],
  });
  return rows[0] ? shapeMember(rows[0]) : null;
}

/**
 * The feeds a topic ring is made of, in the order they joined the directory.
 *
 * Not `feedsForTopic`, on purpose. That query orders by how strongly a feed
 * is filed under the topic, which is the right order for a topic page and
 * the wrong one for a ring: strength changes on every crawl, and a ring's
 * order must not. Admission date and id is stable for ever, and it is also
 * the fairest order a ring can have, since it is the one nobody can game.
 *
 * Only feeds with a site to link to and a healthy crawl. A member is a site,
 * and a feed the crawler has given up on has no page to put a link on.
 *
 * @param {Client} db
 * @param {string} topicSlug
 * @param {number} limit
 * @returns {Promise<Array<{ id: string, slug: string, site_url: string, created_at: string }>>}
 */
export async function topicRingCandidates(db, topicSlug, limit) {
  // Driven from feed_keywords, whose (slug, count) index makes this a range
  // scan of one topic's rows, rather than from feeds, where the same filter
  // is a walk of the whole directory with a subquery per row. Grouped on the
  // feed because a feed can carry several spellings of one slug.
  const { rows } = await db.execute({
    sql: `select f.id, f.slug, f.site_url, f.created_at
            from feed_keywords k
            join feeds f on f.id = k.feed_id
           where k.slug = ?
             and f.status = 'active'
             and f.site_url is not null and f.site_url <> ''
           group by f.id
           order by f.created_at asc, f.id asc
           limit ?`,
    args: [topicSlug, limit],
  });
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    site_url: String(r.site_url),
    created_at: String(r.created_at),
  }));
}

/** How many members a topic ring takes when the caller does not say. */
export const DEFAULT_RING_LIMIT = 100;

/**
 * Create or refresh the ring for one topic.
 *
 * Idempotent, and the property that matters is what it never does: an
 * existing member keeps its position, whatever the topic's feeds look like
 * now. New feeds append after the last member, in admission order, until the
 * ring is `limit` long. A feed that has left the topic or gone dead stays
 * listed; the verification pass decides whether it is active, not this.
 *
 * The title is the topic's most-used spelling (topicLabel.js), so the ring
 * and the topic page always call the subject the same thing.
 *
 * @param {Client} db
 * @param {string} topicSlug
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ slug: string, created: boolean, added: number, total: number }>}
 */
export async function seedTopicRing(db, topicSlug, opts = {}) {
  const limit = Math.max(1, Number(opts.limit ?? DEFAULT_RING_LIMIT) || DEFAULT_RING_LIMIT);
  const now = nowIso();

  const label = await db.execute({
    sql: `select ${topicLabelSql('?')} as keyword`,
    args: [topicSlug],
  });
  const title = String(label.rows[0]?.keyword ?? topicSlug);

  const existing = await ringBySlug(db, topicSlug);
  if (!existing) {
    await db.execute({
      sql: `insert into rings (slug, title, description, kind, topic_slug, accepts, public, created_at, updated_at)
            values (?, ?, ?, 'topic', ?, null, 1, ?, ?)
            on conflict (slug) do nothing`,
      args: [topicSlug, title, `Sites in the directory filed under ${title}.`, topicSlug, now, now],
    });
  }

  const current = await db.execute({
    sql: `select feed_id, position from ring_members where ring_slug = ?`,
    args: [topicSlug],
  });
  const have = new Set(current.rows.map((r) => String(r.feed_id)));
  let position = current.rows.reduce((max, r) => Math.max(max, Number(r.position)), -1);

  const candidates = await topicRingCandidates(db, topicSlug, limit);
  const fresh = candidates.filter((c) => !have.has(c.id)).slice(0, Math.max(0, limit - have.size));

  for (const feed of fresh) {
    position += 1;
    // One statement per member rather than a batch: a ring is seeded once
    // and appended to rarely, and a batch on the throttled primary has
    // failed before where single statements did not (client.js).
    await db.execute({
      sql: `insert into ring_members (ring_slug, feed_id, member_slug, position, site_url, status, joined_at)
            values (?, ?, ?, ?, ?, 'pending', ?)
            on conflict (ring_slug, feed_id) do nothing`,
      args: [topicSlug, feed.id, feed.slug, position, feed.site_url, now],
    });
  }

  if (fresh.length > 0 || !existing) {
    await db.execute({
      sql: `update rings set updated_at = ? where slug = ?`,
      args: [now, topicSlug],
    });
  }

  return { slug: topicSlug, created: !existing, added: fresh.length, total: have.size + fresh.length };
}

/**
 * The topics worth a ring: the most covered, by the rollup's own count.
 *
 * @param {Client} db
 * @param {{ count?: number, minFeeds?: number }} [opts]
 * @returns {Promise<Array<{ slug: string, keyword: string, feed_count: number }>>}
 */
export async function topRingTopics(db, opts = {}) {
  const count = Math.max(1, Number(opts.count ?? 20) || 20);
  const minFeeds = Math.max(1, Number(opts.minFeeds ?? 5) || 5);
  const { rows } = await db.execute({
    sql: `select slug, keyword, feed_count from topics
           where feed_count >= ?
           order by feed_count desc, slug asc
           limit ?`,
    args: [minFeeds, count],
  });
  return rows.map((r) => ({
    slug: String(r.slug),
    keyword: String(r.keyword),
    feed_count: Number(r.feed_count ?? 0),
  }));
}

/**
 * How many feeds a topic ring would hold, before creating it.
 *
 * @param {Client} db
 * @param {string} topicSlug
 * @returns {Promise<number>}
 */
export async function topicRingSize(db, topicSlug) {
  const { rows } = await db.execute({
    sql: `select count(distinct f.id) as n
            from feed_keywords k
            join feeds f on f.id = k.feed_id
           where k.slug = ?
             and f.status = 'active'
             and f.site_url is not null and f.site_url <> ''`,
    args: [topicSlug],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * The members whose check is oldest, across every ring.
 *
 * Never checked first, then oldest check first. `before` excludes members
 * checked recently enough to leave alone, so a pass that runs every tick
 * walks the rings once per recheck period rather than continuously.
 *
 * @param {Client} db
 * @param {number} limit
 * @param {{ before?: string|null }} [opts]
 * @returns {Promise<RingMember[]>}
 */
export async function membersDueForCheck(db, limit, opts = {}) {
  const before = opts.before ?? null;
  const { rows } = await db.execute({
    sql: `select m.ring_slug, m.feed_id, m.member_slug, m.position, m.site_url, m.made_by,
                 m.made_by_source, m.disclosure, m.descriptor_url, m.status, m.checked_at,
                 m.joined_at, f.title, f.feed_url, f.language
            from ring_members m
            join feeds f on f.id = m.feed_id
            join rings r on r.slug = m.ring_slug
           where (m.checked_at is null or ? is null or m.checked_at < ?)
           order by m.checked_at is not null, m.checked_at asc, m.joined_at asc
           limit ?`,
    args: [before, before, Math.max(1, Number(limit) || 1)],
  });
  return rows.map(shapeMember);
}

/**
 * Record a verification result for one member.
 *
 * Status and the stamp always. `made_by` only when the member's page said
 * it (source 'descriptor') and nobody with more authority has already set
 * it: the owner's word and the admin's stand over what a crawler read, and
 * a descriptor that later says nothing does not erase what it said before.
 *
 * @param {Client} db
 * @param {string} ringSlug
 * @param {string} feedId
 * @param {{
 *   status: 'active'|'inactive',
 *   checkedAt?: string,
 *   madeBy?: string|null,
 *   disclosure?: string|null,
 *   descriptorUrl?: string|null,
 * }} result
 * @returns {Promise<void>}
 */
export async function recordCheck(db, ringSlug, feedId, result) {
  const checkedAt = result.checkedAt ?? nowIso();
  const status = result.status === 'active' ? 'active' : 'inactive';
  const madeBy = MADE_BY.includes(String(result.madeBy)) ? String(result.madeBy) : null;
  const disclosure = result.disclosure == null ? null : String(result.disclosure);
  const descriptorUrl = result.descriptorUrl == null ? null : String(result.descriptorUrl);

  await db.execute({
    sql: `update ring_members
             set status = ?,
                 checked_at = ?,
                 descriptor_url = coalesce(?, descriptor_url),
                 made_by = case
                   when ? is not null and coalesce(made_by_source, 'descriptor') = 'descriptor' then ?
                   else made_by end,
                 disclosure = case
                   when ? is not null and coalesce(made_by_source, 'descriptor') = 'descriptor' then ?
                   else disclosure end,
                 made_by_source = case
                   when ? is not null and coalesce(made_by_source, 'descriptor') = 'descriptor' then 'descriptor'
                   else made_by_source end
           where ring_slug = ? and feed_id = ?`,
    args: [
      status,
      checkedAt,
      descriptorUrl,
      madeBy,
      madeBy,
      madeBy,
      disclosure,
      madeBy,
      ringSlug,
      feedId,
    ],
  });
}

/**
 * The owner's, or an admin's, word on who makes a member site.
 *
 * `madeBy: null` clears it back to unstated. The source is recorded so a
 * later descriptor pass knows to leave it alone.
 *
 * @param {Client} db
 * @param {string} ringSlug
 * @param {string} feedId
 * @param {{ madeBy: string|null, disclosure?: string|null, source: 'owner'|'admin' }} word
 * @returns {Promise<RingMember|null>}
 */
export async function setMemberMadeBy(db, ringSlug, feedId, word) {
  const madeBy = MADE_BY.includes(String(word.madeBy)) ? String(word.madeBy) : null;
  const source = word.source === 'admin' ? 'admin' : 'owner';
  await db.execute({
    sql: `update ring_members
             set made_by = ?, disclosure = ?, made_by_source = ?
           where ring_slug = ? and feed_id = ?`,
    args: [madeBy, word.disclosure ?? null, source, ringSlug, feedId],
  });
  const { rows } = await db.execute({
    sql: `select m.ring_slug, m.feed_id, m.member_slug, m.position, m.site_url, m.made_by,
                 m.made_by_source, m.disclosure, m.descriptor_url, m.status, m.checked_at,
                 m.joined_at, f.title, f.feed_url, f.language
            from ring_members m
            join feeds f on f.id = m.feed_id
           where m.ring_slug = ? and m.feed_id = ?
           limit 1`,
    args: [ringSlug, feedId],
  });
  return rows[0] ? shapeMember(rows[0]) : null;
}
