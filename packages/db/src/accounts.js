import { newId, nowIso } from './client.js';

/**
 * Everything the accounts layer reads and writes.
 *
 * Kept apart from queries.js because the directory itself has no notion of a
 * user: feeds, items and submissions are all public, and nothing in there
 * should start taking an account into consideration by accident.
 *
 * @typedef {import('@libsql/client').Client} Client
 */

/**
 * Normalise an address into the form actually stored.
 *
 * Comparison happens on this value everywhere, so it must be the only way an
 * email ever enters the table — otherwise Anthony@ and anthony@ become two
 * accounts holding two different sets of follows.
 *
 * @param {unknown} email
 * @returns {string}
 */
export function normalizeEmail(email) {
  return String(email ?? '')
    .trim()
    .toLowerCase();
}

/**
 * @param {Client} db
 * @param {string} email
 * @returns {Promise<object|null>}
 */
export async function userByEmail(db, email) {
  const { rows } = await db.execute({
    sql: 'select id, email, created_at, last_login_at from users where email = ? limit 1',
    args: [normalizeEmail(email)],
  });
  return rows[0] ?? null;
}

/**
 * @param {Client} db
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function userById(db, id) {
  const { rows } = await db.execute({
    sql: 'select id, email, created_at, last_login_at from users where id = ? limit 1',
    args: [id],
  });
  return rows[0] ?? null;
}

/**
 * Find the account for an address, creating it if this is the first sign-in.
 *
 * Registration is not a separate step: proving you can read the address is the
 * whole of it, so a magic link to an unknown address makes the account rather
 * than refusing and sending the reader off to find a sign-up form.
 *
 * @param {Client} db
 * @param {string} email
 * @returns {Promise<{ id: string, email: string, created: boolean }>}
 */
export async function findOrCreateUser(db, email) {
  const normalized = normalizeEmail(email);
  const existing = await userByEmail(db, normalized);
  if (existing) return { id: String(existing.id), email: normalized, created: false };

  const id = newId();
  const now = nowIso();

  try {
    await db.execute({
      sql: 'insert into users (id, email, created_at) values (?, ?, ?)',
      args: [id, normalized, now],
    });
    return { id, email: normalized, created: true };
  } catch (err) {
    // Two links for the same new address can be clicked at once; whichever
    // insert loses the unique index still has a perfectly good account to use.
    const raced = await userByEmail(db, normalized);
    if (raced) return { id: String(raced.id), email: normalized, created: false };
    throw err;
  }
}

/**
 * @param {Client} db
 * @param {string} id
 */
export async function markUserLoggedIn(db, id) {
  await db.execute({
    sql: 'update users set last_login_at = ? where id = ?',
    args: [nowIso(), id],
  });
}

/* ------------------------------------------------------------- sign-in links */

/**
 * @param {Client} db
 * @param {{ tokenHash: string, email: string, expiresAt: string }} token
 */
export async function insertLoginToken(db, token) {
  await db.execute({
    sql: 'insert into login_tokens (id, email, created_at, expires_at) values (?, ?, ?, ?)',
    args: [token.tokenHash, normalizeEmail(token.email), nowIso(), token.expiresAt],
  });
}

/**
 * Spend a sign-in link, if it is still spendable.
 *
 * The update is the check: `consumed_at is null and expires_at > now` inside
 * the statement means two clicks on the same link race in the database rather
 * than in the application, and only one of them can win.
 *
 * @param {Client} db
 * @param {string} tokenHash
 * @returns {Promise<string|null>} the email it was issued for, or null
 */
export async function consumeLoginToken(db, tokenHash) {
  const now = nowIso();

  const { rows } = await db.execute({
    sql: `update login_tokens set consumed_at = ?
          where id = ? and consumed_at is null and expires_at > ?
          returning email`,
    args: [now, tokenHash, now],
  });

  return rows[0]?.email ? String(rows[0].email) : null;
}

/**
 * How many links were issued for an address recently — the throttle.
 *
 * @param {Client} db
 * @param {string} email
 * @param {number} [windowMs]
 * @returns {Promise<number>}
 */
export async function recentLoginTokenCount(db, email, windowMs = 3_600_000) {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from login_tokens where email = ? and created_at >= ?',
    args: [normalizeEmail(email), nowIso(-windowMs)],
  });
  return Number(rows[0]?.n ?? 0);
}

/* ------------------------------------------------------------------ sessions */

/**
 * @param {Client} db
 * @param {{ tokenHash: string, userId: string, expiresAt: string, userAgent?: string|null, ipHash?: string|null }} session
 */
export async function insertSession(db, session) {
  await db.execute({
    sql: `insert into sessions (id, user_id, created_at, expires_at, user_agent, ip_hash)
          values (?, ?, ?, ?, ?, ?)`,
    args: [
      session.tokenHash,
      session.userId,
      nowIso(),
      session.expiresAt,
      session.userAgent ?? null,
      session.ipHash ?? null,
    ],
  });
}

/**
 * The account behind a session cookie, if the session is still live.
 *
 * @param {Client} db
 * @param {string} tokenHash
 * @returns {Promise<object|null>}
 */
export async function userBySession(db, tokenHash) {
  const { rows } = await db.execute({
    sql: `select u.id, u.email, u.created_at, u.last_login_at
          from sessions s join users u on u.id = s.user_id
          where s.id = ? and s.expires_at > ? limit 1`,
    args: [tokenHash, nowIso()],
  });
  return rows[0] ?? null;
}

/**
 * @param {Client} db
 * @param {string} tokenHash
 */
export async function deleteSession(db, tokenHash) {
  await db.execute({ sql: 'delete from sessions where id = ?', args: [tokenHash] });
}

/**
 * Drop sessions and links that have aged out.
 *
 * Called from the poller: expired rows are already refused on read, so this is
 * housekeeping rather than security, and it belongs somewhere that runs anyway.
 *
 * @param {Client} db
 * @returns {Promise<number>} rows removed
 */
export async function purgeExpired(db) {
  const now = nowIso();

  const results = await db.batch(
    [
      { sql: 'delete from sessions where expires_at < ?', args: [now] },
      { sql: 'delete from webauthn_challenges where expires_at < ?', args: [now] },
      // Spent and stale links are kept an hour past expiry so the throttle
      // still counts them, then dropped.
      { sql: 'delete from login_tokens where expires_at < ?', args: [nowIso(-3_600_000)] },
    ],
    'write',
  );

  return results.reduce((n, r) => n + Number(r.rowsAffected ?? 0), 0);
}

/* --------------------------------------------------------------- challenges */

/**
 * @param {Client} db
 * @param {{ id: string, challenge: string, userId?: string|null, purpose: string, expiresAt: string }} row
 */
export async function insertChallenge(db, row) {
  await db.execute({
    sql: `insert into webauthn_challenges (id, challenge, user_id, purpose, created_at, expires_at)
          values (?, ?, ?, ?, ?, ?)`,
    args: [row.id, row.challenge, row.userId ?? null, row.purpose, nowIso(), row.expiresAt],
  });
}

/**
 * Take a challenge and destroy it in the same breath.
 *
 * A challenge that survives its verification is a replayable one, so it is
 * deleted whether or not the signature that follows turns out to be valid.
 *
 * @param {Client} db
 * @param {string} id
 * @param {string} purpose
 * @returns {Promise<object|null>}
 */
export async function takeChallenge(db, id, purpose) {
  const { rows } = await db.execute({
    sql: `delete from webauthn_challenges
          where id = ? and purpose = ? and expires_at > ?
          returning challenge, user_id`,
    args: [id, purpose, nowIso()],
  });
  return rows[0] ?? null;
}

/* -------------------------------------------------------------- credentials */

/**
 * @param {Client} db
 * @param {object} credential
 */
export async function insertCredential(db, credential) {
  await db.execute({
    sql: `insert into credentials
            (id, user_id, public_key, counter, transports, device_type, backed_up, name,
             created_at, last_used_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, null)`,
    args: [
      credential.id,
      credential.user_id,
      credential.public_key,
      credential.counter ?? 0,
      JSON.stringify(credential.transports ?? []),
      credential.device_type ?? null,
      credential.backed_up ? 1 : 0,
      credential.name ?? null,
      nowIso(),
    ],
  });
}

/**
 * @param {Client} db
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function credentialById(db, id) {
  const { rows } = await db.execute({
    sql: `select id, user_id, public_key, counter, transports, device_type, backed_up, name,
                 created_at, last_used_at
          from credentials where id = ? limit 1`,
    args: [id],
  });
  return rows[0] ?? null;
}

/**
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function credentialsForUser(db, userId) {
  const { rows } = await db.execute({
    sql: `select id, public_key, counter, transports, device_type, backed_up, name,
                 created_at, last_used_at
          from credentials where user_id = ? order by created_at asc`,
    args: [userId],
  });
  return rows;
}

/**
 * Record a successful assertion.
 *
 * The counter is what catches a cloned authenticator, so it has to be written
 * back on every use.
 *
 * @param {Client} db
 * @param {string} id
 * @param {number} counter
 */
export async function touchCredential(db, id, counter) {
  await db.execute({
    sql: 'update credentials set counter = ?, last_used_at = ? where id = ?',
    args: [counter, nowIso(), id],
  });
}

/**
 * @param {Client} db
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<boolean>} whether a credential was actually removed
 */
export async function deleteCredential(db, id, userId) {
  const res = await db.execute({
    sql: 'delete from credentials where id = ? and user_id = ?',
    args: [id, userId],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/* ------------------------------------------------------------------ follows */

/**
 * @param {Client} db
 * @param {string} userId
 * @param {string} feedId
 */
export async function follow(db, userId, feedId) {
  await db.execute({
    sql: `insert into follows (user_id, feed_id, created_at) values (?, ?, ?)
          on conflict do nothing`,
    args: [userId, feedId, nowIso()],
  });
}

/**
 * @param {Client} db
 * @param {string} userId
 * @param {string} feedId
 */
export async function unfollow(db, userId, feedId) {
  await db.execute({
    sql: 'delete from follows where user_id = ? and feed_id = ?',
    args: [userId, feedId],
  });
}

/**
 * @param {Client} db
 * @param {string} userId
 * @param {string} feedId
 * @returns {Promise<boolean>}
 */
export async function isFollowing(db, userId, feedId) {
  const { rows } = await db.execute({
    sql: 'select 1 as n from follows where user_id = ? and feed_id = ? limit 1',
    args: [userId, feedId],
  });
  return rows.length > 0;
}

/**
 * The blogs someone follows, newest first.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function followedFeeds(db, userId, limit = 200) {
  const { rows } = await db.execute({
    sql: `select f.id, f.slug, f.title, f.description, f.site_url, f.feed_url, f.item_count,
                 f.status, fo.created_at as followed_at
          from follows fo join feeds f on f.id = fo.feed_id
          where fo.user_id = ?
          order by fo.created_at desc
          limit ?`,
    args: [userId, limit],
  });
  return rows;
}

/**
 * Recent posts from everything someone follows — the reason to have an account.
 *
 * Carries the same columns a topic river does, because the two are merged into
 * one list on the following page and in the personal feed: a row that arrived by
 * a followed blog and a row that arrived by a followed topic have to be
 * renderable, playable and de-duplicable by the same code.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function followedItems(db, userId, limit = 60) {
  const { rows } = await db.execute({
    sql: `select i.guid, i.url, i.title, i.summary, i.author, i.image_url, i.published_at,
                 i.audio_url, i.audio_type, i.audio_bytes, i.audio_seconds, i.cluster_key,
                 f.slug as feed_slug, f.title as feed_title, f.feed_url, f.category,
                 -- Fallback thumbnail: see the same columns in itemsForTopic.
                 f.image_url as feed_image, f.card_url as feed_card
          from follows fo
          join feeds f on f.id = fo.feed_id
          join feed_items i on i.feed_id = f.id
          where fo.user_id = ?
          order by i.published_at desc nulls last, i.created_at desc
          limit ?`,
    args: [userId, limit],
  });
  return rows;
}

/* ------------------------------------------------------------ topic follows */

/**
 * Normalise the sub-group half of a topic follow.
 *
 * '' is the whole topic. Everything else is a segment from the topic pages, and
 * it is lowercased for the same reason the slug is: the URLs are
 * case-insensitive, so two spellings of one page must not become two follows.
 *
 * @param {unknown} segment
 * @returns {string}
 */
export function normalizeSegment(segment) {
  return String(segment ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Follow a topic, or one category of it.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} slug the normalised topic slug
 * @param {string} [segment] '' for the whole topic
 */
export async function followTopic(db, userId, slug, segment = '') {
  await db.execute({
    sql: `insert into topic_follows (user_id, slug, segment, created_at) values (?, ?, ?, ?)
          on conflict do nothing`,
    args: [userId, slug, normalizeSegment(segment), nowIso()],
  });
}

/**
 * @param {Client} db
 * @param {string} userId
 * @param {string} slug
 * @param {string} [segment]
 */
export async function unfollowTopic(db, userId, slug, segment = '') {
  await db.execute({
    sql: 'delete from topic_follows where user_id = ? and slug = ? and segment = ?',
    args: [userId, slug, normalizeSegment(segment)],
  });
}

/**
 * @param {Client} db
 * @param {string} userId
 * @param {string} slug
 * @param {string} [segment]
 * @returns {Promise<boolean>}
 */
export async function isFollowingTopic(db, userId, slug, segment = '') {
  const { rows } = await db.execute({
    sql: 'select 1 as n from topic_follows where user_id = ? and slug = ? and segment = ? limit 1',
    args: [userId, slug, normalizeSegment(segment)],
  });
  return rows.length > 0;
}

/**
 * The topics someone follows, newest first.
 *
 * Rows carry the slug and segment only. The display name is not stored: a topic
 * has one canonical spelling and it lives in feed_keywords, so copying it here
 * would be a second copy to keep in step for no gain — the page joins it back on
 * when it needs a heading.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function followedTopics(db, userId, limit = 200) {
  const { rows } = await db.execute({
    sql: `select tf.slug, tf.segment, tf.created_at as followed_at,
                 -- The topic's own spelling, so a page can say "AI" rather than
                 -- "ai". Left join: a topic whose feeds have all died still has
                 -- a follow, and the slug is a serviceable fallback.
                 (select min(k.keyword) from feed_keywords k where k.slug = tf.slug) as keyword
          from topic_follows tf
          where tf.user_id = ?
          order by tf.created_at desc
          limit ?`,
    args: [userId, limit],
  });
  return rows;
}

/**
 * How many readers follow a topic, or one category of it.
 *
 * @param {Client} db
 * @param {string} slug
 * @param {string} [segment]
 * @returns {Promise<number>}
 */
export async function topicFollowerCount(db, slug, segment = '') {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from topic_follows where slug = ? and segment = ?',
    args: [slug, normalizeSegment(segment)],
  });
  return Number(rows[0]?.n ?? 0);
}

/* -------------------------------------------------------------- feed tokens */

/**
 * The capability token in an account's personal feed URL, or null.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function feedToken(db, userId) {
  const { rows } = await db.execute({
    sql: 'select feed_token from users where id = ? limit 1',
    args: [userId],
  });
  const token = rows[0]?.feed_token;
  return token ? String(token) : null;
}

/**
 * Set — or rotate — an account's feed token.
 *
 * The value is minted by the caller, the way session tokens are: randomness
 * belongs with the module that owns the credential's format, and this one only
 * stores what it is handed. Writing a new token retires the old one in the same
 * statement, so a rotation takes effect on the next request rather than leaving
 * two live URLs.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} token
 */
export async function setFeedToken(db, userId, token) {
  await db.execute({
    sql: 'update users set feed_token = ? where id = ?',
    args: [token, userId],
  });
}

/**
 * The account a feed token belongs to, or null.
 *
 * An empty token is refused before it reaches the database: `feed_token` is null
 * for every account that has never asked for a URL, and a query for '' must not
 * be allowed to match one of them by accident.
 *
 * @param {Client} db
 * @param {string} token
 * @returns {Promise<object|null>}
 */
export async function userByFeedToken(db, token) {
  const value = String(token ?? '');
  if (!value) return null;

  const { rows } = await db.execute({
    sql: 'select id, email from users where feed_token = ? limit 1',
    args: [value],
  });
  return rows[0] ?? null;
}
