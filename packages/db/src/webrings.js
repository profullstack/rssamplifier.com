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
         r.owner_id, r.created_at, r.updated_at,
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
    owner_id: row.owner_id == null ? null : String(row.owner_id),
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
    description: row.description == null ? null : String(row.description),
    image_url: row.image_url == null ? null : String(row.image_url),
    card_url: row.card_url == null ? null : String(row.card_url),
    item_count: Number(row.item_count ?? 0),
    category: row.category == null ? null : String(row.category),
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
                 m.joined_at, f.title, f.feed_url, f.language, f.description, f.image_url, f.card_url,
                 f.item_count, f.category
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
                 m.joined_at, f.title, f.feed_url, f.language, f.description, f.image_url, f.card_url,
                 f.item_count, f.category
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
  // Driven from the topic's own keyword rows, strongest first. The index
  // feed_keywords_slug_idx is (slug, count desc), so the range scan comes
  // out already in this order and the statement stops at the `limit`th
  // feed that can link; `cross join` pins that join order, because left to
  // itself the planner drove every variant of this from feeds by status,
  // 580,000 rows probed and sorted, and took 80 seconds on the biggest
  // topic against a 30-second request deadline (measured 2026-09-13).
  //
  // So a ring's order is the topic's own: the sites most about it first.
  // Stable all the same: a position is written once and new members append.
  const { rows } = await db.execute({
    sql: `select f.id, f.slug, f.site_url, f.created_at
            from feed_keywords k indexed by feed_keywords_slug_idx
            cross join feeds f on f.id = k.feed_id
           where k.slug = ?
             and f.status = 'active'
             and f.site_url is not null and f.site_url <> ''
           order by k.count desc
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

  // The rollup already holds the topic's label; recomputing it groups every
  // keyword row of the slug (seven seconds on the biggest topic). The
  // recomputation is the fallback for a topic the rollup has not seen.
  const rolled = await db.execute({ sql: `select keyword from topics where slug = ?`, args: [topicSlug] });
  let title = rolled.rows[0]?.keyword ? String(rolled.rows[0].keyword) : '';
  if (!title) {
    const label = await db.execute({ sql: `select ${topicLabelSql('?')} as keyword`, args: [topicSlug] });
    title = String(label.rows[0]?.keyword ?? topicSlug);
  }

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

/** A ring needs a subject; a slug this short is a stopword or a language code. */
export const MIN_RING_TOPIC_LENGTH = 3;

/**
 * Category tags that are containers rather than subjects. Publishers file
 * under these by default (WordPress's own is "uncategorized"), so they rank
 * high and mean nothing; a ring of "uncategorized" is a ring of anything.
 */
export const RING_TOPIC_STOPLIST = new Set([
  'uncategorized', 'uncategorised', 'general', 'misc', 'miscellaneous', 'other', 'others',
  'blog', 'blogs', 'blogging', 'post', 'posts', 'article', 'articles', 'feed', 'rss', 'default',
  'news-feed', 'updates', 'update', 'home', 'homepage', 'main', 'featured', 'all', 'various', 'random',
]);

/**
 * The topics worth a ring: the subjects publishers file themselves under.
 *
 * The rollup's own order is no use here. `topics` counts every phrase the
 * crawler lifts out of prose, so its top of the table is "one", "de",
 * "episode", "time": the most common words in a hundred thousand feeds, not
 * their subjects. A ring named after one of those is a ring of everything.
 * So the candidates are ranked by the feeds that carry the slug as their
 * OWN category tag (feed_keywords.source = 'category'), which is what a
 * publisher says the site is about, and only feeds a ring can use count: an
 * active feed with a site to link from.
 *
 * Bounded the same way the seed is: the rollup (indexed by feed_count)
 * names the pool, then each candidate costs one range scan of its own
 * keyword rows, rather than one pass over every keyword row in the table.
 *
 * @param {Client} db
 * @param {{ count?: number, minFeeds?: number, pool?: number }} [opts]
 * @returns {Promise<Array<{ slug: string, keyword: string, feed_count: number }>>}
 */
export async function topRingTopics(db, opts = {}) {
  const count = Math.max(1, Number(opts.count ?? 20) || 20);
  const minFeeds = Math.max(1, Number(opts.minFeeds ?? 5) || 5);
  // Each candidate costs a range scan of its keyword rows (six seconds on
  // the biggest topic), so the pool is kept to a few times the rings wanted.
  const pool = Math.max(count, Number(opts.pool ?? count * 5) || count * 5);
  const { rows } = await db.execute({
    sql: `select slug, keyword from topics
           where feed_count >= ? and length(slug) >= ?
           order by feed_count desc, slug asc
           limit ?`,
    args: [minFeeds, MIN_RING_TOPIC_LENGTH, pool],
  });

  const ranked = [];
  for (const r of rows) {
    const slug = String(r.slug);
    if (RING_TOPIC_STOPLIST.has(slug)) continue;
    const counted = await db.execute({
      sql: `select count(*) as n
              from feed_keywords k indexed by feed_keywords_slug_idx
              cross join feeds f on f.id = k.feed_id
             where k.slug = ? and k.source = 'category'
               and f.status = 'active'
               and f.site_url is not null and f.site_url <> ''`,
      args: [slug],
    });
    const n = Number(counted.rows[0]?.n ?? 0);
    if (n >= minFeeds) ranked.push({ slug, keyword: String(r.keyword), feed_count: n });
  }
  ranked.sort((a, b) => b.feed_count - a.feed_count || a.slug.localeCompare(b.slug));
  return ranked.slice(0, count);
}

/**
 * Remove topic rings whose topic no longer qualifies, when nobody would
 * miss them: fewer than `keepActive` active members. A ring with members
 * who put its links on their pages stays whatever the ranking says.
 *
 * @param {Client} db
 * @param {string[]} keepSlugs the topics that qualify now
 * @param {{ keepActive?: number }} [opts]
 * @returns {Promise<string[]>} the slugs removed
 */
export async function dropStaleTopicRings(db, keepSlugs, opts = {}) {
  const keepActive = Math.max(1, Number(opts.keepActive ?? 5) || 5);
  const keep = new Set(keepSlugs.map(String));
  const { rows } = await db.execute({
    sql: `select r.slug,
                 (select count(*) from ring_members m where m.ring_slug = r.slug and m.status = 'active') as active
            from rings r
           where r.kind = 'topic'`,
  });
  const gone = [];
  for (const r of rows) {
    const slug = String(r.slug);
    if (keep.has(slug) || Number(r.active ?? 0) >= keepActive) continue;
    await db.execute({ sql: `delete from ring_members where ring_slug = ?`, args: [slug] });
    await db.execute({ sql: `delete from rings where slug = ?`, args: [slug] });
    gone.push(slug);
  }
  return gone;
}

/**
 * How many feeds a topic ring would hold, before creating it.
 *
 * @param {Client} db
 * @param {string} topicSlug
 * @returns {Promise<number>}
 */
export async function topicRingSize(db, topicSlug, opts = {}) {
  // `cap` stops the count once it is high enough to answer the caller's
  // question ("at least five?"), so the biggest topics cost the same as the
  // smallest. Without it the count is exact.
  const cap = Number(opts.cap) > 0 ? Number(opts.cap) : null;
  const { rows } = await db.execute({
    sql: `select count(*) as n from (
            select f.id
              from feeds f
             where f.status = 'active'
               and f.site_url is not null and f.site_url <> ''
               and exists (select 1 from feed_keywords k where k.feed_id = f.id and k.slug = ?)
             ${cap ? 'limit ?' : ''}
          )`,
    args: cap ? [topicSlug, cap] : [topicSlug],
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
                 m.joined_at, f.title, f.feed_url, f.language, f.description, f.image_url, f.card_url,
                 f.item_count, f.category
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
                 m.joined_at, f.title, f.feed_url, f.language, f.description, f.image_url, f.card_url,
                 f.item_count, f.category
            from ring_members m
            join feeds f on f.id = m.feed_id
           where m.ring_slug = ? and m.feed_id = ?
           limit 1`,
    args: [ringSlug, feedId],
  });
  return rows[0] ? shapeMember(rows[0]) : null;
}

/* ------------------------------------------------------------ every topic */

/**
 * A topic as a ring, computed rather than stored.
 *
 * Every topic is a ring: the same feeds the topic page lists, in the topic's
 * own order, strongest first. Nothing is written. The ring becomes a row the
 * moment a member site actually links back (see the check route), and until
 * then it is re-derived on each load, which is the same freshness the topic
 * page has. Null when the topic has no feed with a site to link from.
 *
 * The members carry the same shape as stored members, all `pending` and all
 * unstated, and the ring says `virtual: true` so a writer knows there is no
 * row under it yet.
 *
 * @param {Client} db
 * @param {string} topicSlug
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ ring: Ring & { virtual: true }, members: RingMember[] }|null>}
 */
export async function topicRingPreview(db, topicSlug, opts = {}) {
  const limit = Math.max(1, Number(opts.limit ?? DEFAULT_RING_LIMIT) || DEFAULT_RING_LIMIT);
  // The same driving index and join order as topicRingCandidates; see there
  // for why the planner must not be left to choose.
  const { rows } = await db.execute({
    sql: `select f.id as feed_id, f.slug as member_slug, f.site_url, f.created_at as joined_at,
                 f.title, f.feed_url, f.language, f.description, f.image_url, f.card_url,
                 f.item_count, f.category
            from feed_keywords k indexed by feed_keywords_slug_idx
            cross join feeds f on f.id = k.feed_id
           where k.slug = ?
             and f.status = 'active'
             and f.site_url is not null and f.site_url <> ''
           order by k.count desc
           limit ?`,
    args: [topicSlug, limit],
  });
  if (rows.length === 0) return null;

  const rolled = await db.execute({ sql: `select keyword from topics where slug = ?`, args: [topicSlug] });
  const title = rolled.rows[0]?.keyword ? String(rolled.rows[0].keyword) : topicSlug;
  const now = nowIso();
  const members = rows.map((r, i) =>
    shapeMember({
      ...r,
      ring_slug: topicSlug,
      position: i + 1,
      made_by: null,
      made_by_source: null,
      disclosure: null,
      descriptor_url: null,
      status: 'pending',
      checked_at: null,
    }),
  );
  return {
    ring: {
      slug: topicSlug,
      title,
      description: null,
      kind: 'topic',
      topic_slug: topicSlug,
      accepts: null,
      owner_id: null,
      public: true,
      created_at: now,
      updated_at: now,
      member_count: members.length,
      active_count: 0,
      updated: now,
      virtual: /** @type {const} */ (true),
    },
    members,
  };
}

/* --------------------------------------------------------- your own ring */

/**
 * A ring somebody makes on the site. Public from the moment it exists: it is
 * on the host file, the ring index and the hops as soon as this returns.
 *
 * @param {Client} db
 * @param {{ slug: string, title: string, description?: string|null, ownerId: string }} ring
 * @returns {Promise<Ring|null>} null when the slug is taken
 */
export async function createRing(db, { slug, title, description = null, ownerId }) {
  const now = nowIso();
  const done = await db.execute({
    sql: `insert into rings (slug, title, description, kind, topic_slug, accepts, public, owner_id, created_at, updated_at)
          values (?, ?, ?, 'curated', null, null, 1, ?, ?, ?) on conflict (slug) do nothing`,
    args: [slug, title, description || null, ownerId, now, now],
  });
  if (Number(done.rowsAffected ?? 0) === 0) return null;
  return ringBySlug(db, slug);
}

/**
 * @param {Client} db
 * @param {string} slug
 * @param {{ title?: string, description?: string|null }} patch
 * @returns {Promise<void>}
 */
export async function updateRing(db, slug, patch) {
  await db.execute({
    sql: `update rings
             set title = coalesce(?, title),
                 description = case when ? then ? else description end,
                 updated_at = ?
           where slug = ?`,
    args: [patch.title ?? null, 'description' in patch ? 1 : 0, patch.description ?? null, nowIso(), slug],
  });
}

/**
 * Append feeds to a ring, in the order given, after whoever is already there.
 * A feed already in the ring keeps its place. Positions are never rewritten.
 *
 * @param {Client} db
 * @param {string} ringSlug
 * @param {Array<{ id: string, slug: string, site_url: string }>} feeds
 * @returns {Promise<number>} how many were added
 */
export async function addRingMembers(db, ringSlug, feeds) {
  const current = await db.execute({
    sql: `select feed_id, position from ring_members where ring_slug = ?`,
    args: [ringSlug],
  });
  const have = new Set(current.rows.map((r) => String(r.feed_id)));
  let position = current.rows.reduce((max, r) => Math.max(max, Number(r.position)), 0);
  const now = nowIso();
  let added = 0;
  for (const feed of feeds) {
    if (!feed.site_url || have.has(String(feed.id))) continue;
    position += 1;
    await db.execute({
      sql: `insert into ring_members (ring_slug, feed_id, member_slug, position, site_url, status, joined_at)
            values (?, ?, ?, ?, ?, 'pending', ?) on conflict (ring_slug, feed_id) do nothing`,
      args: [ringSlug, String(feed.id), String(feed.slug), position, String(feed.site_url), now],
    });
    have.add(String(feed.id));
    added += 1;
  }
  if (added) await db.execute({ sql: `update rings set updated_at = ? where slug = ?`, args: [now, ringSlug] });
  return added;
}

/**
 * @param {Client} db
 * @param {string} ringSlug
 * @param {string} memberSlug
 * @returns {Promise<boolean>}
 */
export async function removeRingMember(db, ringSlug, memberSlug) {
  const done = await db.execute({
    sql: `delete from ring_members where ring_slug = ? and member_slug = ?`,
    args: [ringSlug, memberSlug],
  });
  const gone = Number(done.rowsAffected ?? 0) > 0;
  if (gone) await db.execute({ sql: `update rings set updated_at = ? where slug = ?`, args: [nowIso(), ringSlug] });
  return gone;
}

/**
 * @param {Client} db
 * @param {string} ownerId
 * @returns {Promise<Ring[]>}
 */
export async function ringsOwnedBy(db, ownerId) {
  const { rows } = await db.execute({
    sql: `${RING_SELECT} where r.owner_id = ? order by r.updated_at desc`,
    args: [ownerId],
  });
  return rows.map(shapeRing);
}

/**
 * The feed somebody means when they type a site, a feed URL or a directory
 * slug into a ring's member box. Null when it is not in the directory.
 *
 * @param {Client} db
 * @param {string} input
 * @returns {Promise<{ id: string, slug: string, site_url: string, title: string }|null>}
 */
export async function feedForRingInput(db, input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const cols = `id, slug, site_url, title`;
  const shape = (/** @type {any} */ r) =>
    r ? { id: String(r.id), slug: String(r.slug), site_url: String(r.site_url ?? ''), title: String(r.title ?? r.slug) } : null;

  if (!/^https?:\/\//i.test(raw)) {
    const bySlug = await db.execute({
      sql: `select ${cols} from feeds where slug = ? and status <> 'dead' limit 1`,
      args: [raw.toLowerCase().replace(/^\/+|\/+$/g, '')],
    });
    return shape(bySlug.rows[0]);
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const bare = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const variants = [raw, bare, `${bare}/`];
  const found = await db.execute({
    sql: `select ${cols} from feeds
           where (feed_url in (?, ?, ?) or site_url in (?, ?, ?)) and status <> 'dead'
           order by case when site_url in (?, ?, ?) then 0 else 1 end, item_count desc
           limit 1`,
    args: [...variants, ...variants, ...variants],
  });
  return shape(found.rows[0]);
}

/* -------------------------------------------------------- likes and events */

/** What people do with rings; the leaderboard weighs each (lib/ringLeaderboard.js). */
export const RING_EVENT_KINDS = ['view', 'share', 'like', 'follow', 'add', 'make'];

/**
 * Like a ring, or take the like back. On or off, never counted twice.
 *
 * @param {Client} db
 * @param {string} ringSlug
 * @param {string} userId
 * @param {boolean} liked
 * @returns {Promise<boolean>} the state afterwards
 */
export async function likeRing(db, ringSlug, userId, liked) {
  if (liked) {
    await db.execute({
      sql: `insert into ring_likes (ring_slug, user_id, created_at) values (?, ?, ?)
            on conflict (ring_slug, user_id) do nothing`,
      args: [ringSlug, userId, nowIso()],
    });
  } else {
    await db.execute({ sql: `delete from ring_likes where ring_slug = ? and user_id = ?`, args: [ringSlug, userId] });
  }
  return liked;
}

/**
 * @param {Client} db
 * @param {string} ringSlug
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function ringLiked(db, ringSlug, userId) {
  const { rows } = await db.execute({
    sql: `select 1 as one from ring_likes where ring_slug = ? and user_id = ? limit 1`,
    args: [ringSlug, userId],
  });
  return rows.length > 0;
}

/**
 * @param {Client} db
 * @param {string} ringSlug
 * @returns {Promise<number>}
 */
export async function ringLikes(db, ringSlug) {
  const { rows } = await db.execute({ sql: `select count(*) as n from ring_likes where ring_slug = ?`, args: [ringSlug] });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Likes per ring, for a list of rings.
 *
 * @param {Client} db
 * @param {string[]} slugs
 * @returns {Promise<Record<string, number>>}
 */
export async function ringLikeCounts(db, slugs) {
  /** @type {Record<string, number>} */
  const out = {};
  if (slugs.length === 0) return out;
  const marks = slugs.map(() => '?').join(', ');
  const { rows } = await db.execute({
    sql: `select ring_slug, count(*) as n from ring_likes where ring_slug in (${marks}) group by ring_slug`,
    args: slugs,
  });
  for (const r of rows) out[String(r.ring_slug)] = Number(r.n);
  return out;
}

/**
 * One fact with a time: somebody did this with this ring.
 *
 * @param {Client} db
 * @param {{ kind: string, ringSlug: string, memberSlug?: string|null, userId?: string|null }} event
 * @returns {Promise<void>}
 */
export async function recordRingEvent(db, { kind, ringSlug, memberSlug = null, userId = null }) {
  if (!RING_EVENT_KINDS.includes(kind)) throw new Error(`unknown ring event: ${kind}`);
  await db.execute({
    sql: `insert into ring_events (kind, ring_slug, member_slug, user_id, created_at) values (?, ?, ?, ?, ?)`,
    args: [kind, ringSlug, memberSlug, userId, nowIso()],
  });
}

/**
 * The log since a moment, oldest first, for the leaderboard to project.
 *
 * @param {Client} db
 * @param {string} sinceIso
 * @param {number} [limit]
 * @returns {Promise<Array<{ kind: string, ring_slug: string, member_slug: string|null, user_id: string|null, created_at: string }>>}
 */
export async function ringEventsSince(db, sinceIso, limit = 100000) {
  const { rows } = await db.execute({
    sql: `select kind, ring_slug, member_slug, user_id, created_at from ring_events
           where created_at >= ? order by created_at asc, id asc limit ?`,
    args: [sinceIso, limit],
  });
  return rows.map((r) => ({
    kind: String(r.kind),
    ring_slug: String(r.ring_slug),
    member_slug: r.member_slug == null ? null : String(r.member_slug),
    user_id: r.user_id == null ? null : String(r.user_id),
    created_at: String(r.created_at),
  }));
}

/**
 * The rings people like most: likes, then linking members, then size.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<Array<Ring & { likes: number }>>}
 */
export async function topRings(db, limit = 5) {
  const { rows } = await db.execute({
    sql: `${RING_SELECT}
           where r.public = 1
           order by (select count(*) from ring_likes l where l.ring_slug = r.slug) desc,
                    active_count desc, member_count desc, r.slug asc
           limit ?`,
    args: [limit],
  });
  const rings = rows.map(shapeRing);
  const likes = await ringLikeCounts(db, rings.map((r) => r.slug));
  return rings.map((r) => ({ ...r, likes: likes[r.slug] ?? 0 }));
}

/**
 * A title for each slug: the ring's own, or the topic's for a ring that is
 * still computed from its topic, or the slug.
 *
 * @param {Client} db
 * @param {string[]} slugs
 * @returns {Promise<Record<string, string>>}
 */
export async function ringNames(db, slugs) {
  /** @type {Record<string, string>} */
  const out = {};
  if (slugs.length === 0) return out;
  const marks = slugs.map(() => '?').join(', ');
  const rings = await db.execute({ sql: `select slug, title from rings where slug in (${marks})`, args: slugs });
  for (const r of rings.rows) out[String(r.slug)] = String(r.title);
  const rest = slugs.filter((s) => !(s in out));
  if (rest.length) {
    const topics = await db.execute({
      sql: `select slug, keyword from topics where slug in (${rest.map(() => '?').join(', ')})`,
      args: rest,
    });
    for (const r of topics.rows) out[String(r.slug)] = String(r.keyword);
  }
  for (const s of slugs) out[s] ??= s;
  return out;
}
