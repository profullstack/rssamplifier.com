import { newId, nowIso } from './client.js';
import { normalizeSegment } from './accounts.js';

/**
 * Alerts: the reads and writes behind being told about a new post.
 *
 * Three concerns, kept apart on purpose:
 *
 *   * the **flag** on a follow — whether this particular blog or topic is worth
 *     interrupting somebody for;
 *   * the **channels** — where an account's alerts go, which is a property of
 *     the account rather than of any one follow;
 *   * the **watermark and sent-log** — what has already been told, which is the
 *     only part that has to survive a daemon restart mid-fan-out.
 *
 * @typedef {import('@libsql/client').Client} Client
 */

/* -------------------------------------------------------------- topic kinds */

/**
 * The categories each topic sub-group is made of.
 *
 * A mirror of the web app's TOPIC_GROUPS, which is the thing that mints these
 * segments in the first place. It is duplicated here rather than imported
 * because the sender runs in the poller, which has no business depending on the
 * Next application — and it is duplicated *safely* because
 * `apps/web/test/alerts.test.js` asserts the two agree, so a renamed category
 * fails a test instead of silently switching one reader's alerts off.
 *
 * '' is absent deliberately: the whole topic is "no filter", not "every kind".
 *
 * @type {Record<string, string[]>}
 */
export const SEGMENT_KINDS = {
  blogs: ['blog'],
  news: ['news'],
  podcasts: ['podcast'],
  music: ['music'],
  audio: ['podcast', 'music'],
  videos: ['video'],
  comics: ['comic'],
  lives: ['live'],
  reels: ['reel'],
};

/**
 * The category filter a topic follow's segment implies, or null for no filter.
 *
 * An unrecognised segment — a category renamed since the follow was made — is
 * treated as the whole topic rather than as nothing, which is what the topic
 * pages already do with the same input. A follow that quietly stopped matching
 * anything would look exactly like a topic nobody writes about any more.
 *
 * @param {unknown} segment
 * @returns {string[]|null}
 */
export function segmentKinds(segment) {
  const key = normalizeSegment(segment);
  if (!key) return null;
  return SEGMENT_KINDS[key] ?? null;
}

/* ------------------------------------------------------------------- the flag */

/**
 * Turn alerts on or off for a followed blog.
 *
 * Only ever updates an existing follow: alerting on something you do not follow
 * is not a state the UI can produce, and creating the follow here would let a
 * single request do two things the reader asked for one of.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} feedId
 * @param {boolean} on
 * @returns {Promise<boolean>} whether a follow was there to change
 */
export async function setFeedAlerts(db, userId, feedId, on) {
  const res = await db.execute({
    sql: 'update follows set alerts = ? where user_id = ? and feed_id = ?',
    args: [on ? 1 : 0, userId, feedId],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * Turn alerts on or off for a followed topic.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} slug
 * @param {string} [segment]
 * @param {boolean} [on]
 * @returns {Promise<boolean>}
 */
export async function setTopicAlerts(db, userId, slug, segment = '', on = true) {
  const res = await db.execute({
    sql: 'update topic_follows set alerts = ? where user_id = ? and slug = ? and segment = ?',
    args: [on ? 1 : 0, userId, slug, normalizeSegment(segment)],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * Whether a blog is followed, and whether it alerts — in one round trip.
 *
 * Both halves are needed together everywhere they are needed at all: a feed page
 * renders the follow button and the bell beside it, and asking twice would be
 * two queries for one row.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} feedId
 * @returns {Promise<{ following: boolean, alerts: boolean }>}
 */
export async function feedFollowState(db, userId, feedId) {
  const { rows } = await db.execute({
    sql: 'select alerts from follows where user_id = ? and feed_id = ? limit 1',
    args: [userId, feedId],
  });
  if (rows.length === 0) return { following: false, alerts: false };
  return { following: true, alerts: Number(rows[0]?.alerts ?? 0) === 1 };
}

/**
 * The same, for a topic or one category of it.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} slug
 * @param {string} [segment]
 * @returns {Promise<{ following: boolean, alerts: boolean }>}
 */
export async function topicFollowState(db, userId, slug, segment = '') {
  const { rows } = await db.execute({
    sql: 'select alerts from topic_follows where user_id = ? and slug = ? and segment = ? limit 1',
    args: [userId, slug, normalizeSegment(segment)],
  });
  if (rows.length === 0) return { following: false, alerts: false };
  return { following: true, alerts: Number(rows[0]?.alerts ?? 0) === 1 };
}

/**
 * Turn alerts on or off for a followed author.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} authorId
 * @param {boolean} on
 * @returns {Promise<boolean>}
 */
export async function setAuthorAlerts(db, userId, authorId, on) {
  const res = await db.execute({
    sql: 'update author_follows set alerts = ? where user_id = ? and author_id = ?',
    args: [on ? 1 : 0, userId, authorId],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * The same, for a person.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} authorId
 * @returns {Promise<{ following: boolean, alerts: boolean }>}
 */
export async function authorFollowState(db, userId, authorId) {
  const { rows } = await db.execute({
    sql: 'select alerts from author_follows where user_id = ? and author_id = ? limit 1',
    args: [userId, authorId],
  });
  if (rows.length === 0) return { following: false, alerts: false };
  return { following: true, alerts: Number(rows[0]?.alerts ?? 0) === 1 };
}

/**
 * Everything one account has switched alerts on for, both kinds together.
 *
 * For the account page, which lists them, and for nothing else — the sender
 * reads the two halves separately because it queries them differently.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<{ feeds: object[], topics: object[] }>}
 */
export async function alertingFollows(db, userId) {
  const [feeds, topics, people] = await Promise.all([
    db.execute({
      sql: `select f.slug, f.title
            from follows fo join feeds f on f.id = fo.feed_id
            where fo.user_id = ? and fo.alerts = 1
            order by fo.created_at desc`,
      args: [userId],
    }),
    db.execute({
      sql: `select tf.slug, tf.segment,
                   (select min(k.keyword) from feed_keywords k where k.slug = tf.slug) as keyword
            from topic_follows tf
            where tf.user_id = ? and tf.alerts = 1
            order by tf.created_at desc`,
      args: [userId],
    }),
    db.execute({
      sql: `select a.slug, a.name
            from author_follows af join authors a on a.id = af.author_id
            where af.user_id = ? and af.alerts = 1
            order by af.created_at desc`,
      args: [userId],
    }),
  ]);

  return { feeds: feeds.rows, topics: topics.rows, authors: people.rows };
}

/* ---------------------------------------------------------------- channels */

/** The channel kinds the sender knows how to deliver to. */
export const CHANNEL_KINDS = ['email', 'web', 'webhook'];

/**
 * How many channels one account may hold.
 *
 * A ceiling rather than a policy: every alert fans out across every channel, so
 * an account with a thousand webhooks is a thousand outbound requests per new
 * post, aimed by somebody else. Ten is more devices and endpoints than anyone
 * has asked for.
 */
export const MAX_CHANNELS_PER_USER = 10;

/**
 * How many consecutive failures retire a channel.
 *
 * Push endpoints are the reason this exists. A browser whose site data was
 * cleared answers 410 for ever, and there is no other signal that it is gone —
 * so the sender has to notice by counting. Five is enough to ride out a
 * provider having a bad afternoon.
 */
export const MAX_CHANNEL_FAILURES = 5;

/**
 * Record a destination for an account's alerts.
 *
 * Re-adding one that is already there is a no-op that also *revives* it: a
 * browser re-subscribing after its endpoint rotated, or a reader re-adding an
 * address that had been auto-disabled, both mean "this works again", and both
 * arrive here. So the conflict clause clears the failure state rather than
 * leaving a resurrected channel switched off with no way to notice.
 *
 * @param {Client} db
 * @param {{ userId: string, kind: string, target: string, secret?: unknown, label?: string }} channel
 * @returns {Promise<string>} the channel id
 */
export async function addChannel(db, channel) {
  const id = newId();
  const secret = channel.secret ? JSON.stringify(channel.secret) : null;

  await db.execute({
    sql: `insert into alert_channels (id, user_id, kind, target, secret, label, enabled, created_at)
          values (?, ?, ?, ?, ?, ?, 1, ?)
          on conflict (user_id, kind, target) do update set
            secret     = excluded.secret,
            label      = excluded.label,
            enabled    = 1,
            failures   = 0,
            last_error = null`,
    args: [
      id,
      channel.userId,
      channel.kind,
      channel.target,
      secret,
      String(channel.label ?? ''),
      nowIso(),
    ],
  });

  // The insert may have been a no-op update against a row with a different id,
  // so the id worth returning is whatever is actually stored.
  const { rows } = await db.execute({
    sql: 'select id from alert_channels where user_id = ? and kind = ? and target = ? limit 1',
    args: [channel.userId, channel.kind, channel.target],
  });
  return String(rows[0]?.id ?? id);
}

/**
 * How many channels an account already holds.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function channelCount(db, userId) {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from alert_channels where user_id = ?',
    args: [userId],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Every channel an account holds, switched on or not.
 *
 * The secret is not selected. It is a push subscription's encryption key or a
 * webhook's signing secret, and the account page has no use for either — it
 * lists what exists and how it is doing.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function channelsForUser(db, userId) {
  const { rows } = await db.execute({
    sql: `select id, kind, target, label, enabled, created_at, last_ok_at, last_error, failures
          from alert_channels where user_id = ?
          order by created_at`,
    args: [userId],
  });
  return rows;
}

/**
 * The channels the sender should actually deliver to, secrets included.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<Array<{ id: string, kind: string, target: string, secret: object|null }>>}
 */
export async function deliverableChannels(db, userId) {
  const { rows } = await db.execute({
    sql: `select id, kind, target, secret from alert_channels
          where user_id = ? and enabled = 1`,
    args: [userId],
  });

  return rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    target: String(row.target),
    // A secret that will not parse is treated as absent rather than thrown: one
    // corrupt row must not stop an account's other channels from being sent to.
    secret: parseSecret(row.secret),
  }));
}

/**
 * @param {unknown} raw
 * @returns {object|null}
 */
function parseSecret(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(String(raw));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Switch a channel on or off. Scoped to its owner, so an id is not a capability.
 *
 * Switching one back on clears the failure count: the reader is asserting it
 * works, and leaving the count at its ceiling would have the sender retire it
 * again on the next failure rather than giving it a fresh run.
 *
 * @param {Client} db
 * @param {string} id
 * @param {string} userId
 * @param {boolean} on
 * @returns {Promise<boolean>}
 */
export async function setChannelEnabled(db, id, userId, on) {
  const res = await db.execute({
    sql: `update alert_channels
          set enabled = ?, failures = case when ? = 1 then 0 else failures end
          where id = ? and user_id = ?`,
    args: [on ? 1 : 0, on ? 1 : 0, id, userId],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * @param {Client} db
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function deleteChannel(db, id, userId) {
  const res = await db.execute({
    sql: 'delete from alert_channels where id = ? and user_id = ?',
    args: [id, userId],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * Remove a push channel by its endpoint.
 *
 * The browser side of unsubscribe knows the endpoint, not the id — and after a
 * `pushsubscriptionchange` it may know only the *old* endpoint, which is exactly
 * the row that needs clearing.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} endpoint
 * @returns {Promise<boolean>}
 */
export async function deletePushChannel(db, userId, endpoint) {
  const res = await db.execute({
    sql: "delete from alert_channels where user_id = ? and kind = 'web' and target = ?",
    args: [userId, endpoint],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * Record how a delivery went.
 *
 * A success resets the failure count; a failure raises it, and the channel
 * retires itself once it has failed MAX_CHANNEL_FAILURES times in a row. Both
 * happen in one statement so a concurrent send cannot read a count between the
 * two halves of a read-modify-write.
 *
 * `gone` is the shortcut for the case that needs no counting: a push endpoint
 * answering 404 or 410 is not a bad afternoon, it is a browser that no longer
 * exists, and retrying it four more times is four requests spent on a certainty.
 *
 * @param {Client} db
 * @param {string} id
 * @param {{ ok: boolean, error?: string, gone?: boolean }} result
 */
export async function recordChannelResult(db, id, result) {
  if (result.ok) {
    await db.execute({
      sql: `update alert_channels
            set last_ok_at = ?, failures = 0, last_error = null
            where id = ?`,
      args: [nowIso(), id],
    });
    return;
  }

  await db.execute({
    sql: `update alert_channels
          set failures   = failures + 1,
              last_error = ?,
              enabled    = case when ? = 1 or failures + 1 >= ? then 0 else enabled end
          where id = ?`,
    args: [String(result.error ?? 'failed').slice(0, 300), result.gone ? 1 : 0, MAX_CHANNEL_FAILURES, id],
  });
}

/* ------------------------------------------------------------ who to send to */

/**
 * The accounts with something to be alerted about and somewhere to send it.
 *
 * Both halves are required, and requiring them here is what keeps the sender's
 * per-account work off accounts that would produce nothing: a reader who
 * switched every channel off still has their alert flags, and a reader with a
 * phone attached but no follow alerting has nothing to say.
 *
 * Ordered by how long it has been since they were last considered, so a large
 * user base is walked round-robin rather than the sender re-serving the same
 * head of the list every tick. Never-considered accounts sort first, which is
 * what makes a new sign-up's first alert prompt.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<Array<{ id: string, email: string }>>}
 */
export async function usersWithAlerts(db, limit = 50) {
  const { rows } = await db.execute({
    sql: `select u.id, u.email, s.updated_at
          from users u
          left join alert_state s on s.user_id = u.id
          where exists (select 1 from alert_channels c
                        where c.user_id = u.id and c.enabled = 1)
            and (exists (select 1 from follows fo
                         where fo.user_id = u.id and fo.alerts = 1)
              or exists (select 1 from topic_follows tf
                         where tf.user_id = u.id and tf.alerts = 1)
              or exists (select 1 from author_follows af
                         where af.user_id = u.id and af.alerts = 1))
          order by s.updated_at is not null, s.updated_at
          limit ?`,
    args: [limit],
  });

  return rows.map((row) => ({ id: String(row.id), email: String(row.email ?? '') }));
}

/**
 * How many accounts the sender has anything to do for.
 *
 * The same predicate as `usersWithAlerts`, counted rather than listed, and it
 * exists for one reason: /crawlstats cannot otherwise tell a sender that has
 * stopped from a sender with nobody to send to.
 *
 * The pass logs only when it had somebody to consider, so on a deployment where
 * nobody has switched alerts on it writes nothing at all — which the job board
 * reads as a worker that has died, and reports as the one unambiguous alarm on
 * the page. That is a false alarm on a feature that is working perfectly, and
 * this number is what tells the two apart.
 *
 * @param {Client} db
 * @returns {Promise<number>}
 */
export async function alertingAccountCount(db) {
  const { rows } = await db.execute(
    `select count(*) as n from users u
     where exists (select 1 from alert_channels c
                   where c.user_id = u.id and c.enabled = 1)
       and (exists (select 1 from follows fo
                    where fo.user_id = u.id and fo.alerts = 1)
         or exists (select 1 from topic_follows tf
                    where tf.user_id = u.id and tf.alerts = 1)
         or exists (select 1 from author_follows af
                    where af.user_id = u.id and af.alerts = 1))`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * How far through the firehose an account has been told, or null if never.
 *
 * Null is load-bearing: it means "switched alerts on just now", and the sender
 * answers it by setting the watermark to the present rather than by mailing
 * somebody the last two years of a topic they just discovered.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function alertCursor(db, userId) {
  const { rows } = await db.execute({
    sql: 'select cursor from alert_state where user_id = ? limit 1',
    args: [userId],
  });
  const cursor = rows[0]?.cursor;
  return cursor ? String(cursor) : null;
}

/**
 * Move an account's watermark.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} cursor
 */
export async function setAlertCursor(db, userId, cursor) {
  await db.execute({
    sql: `insert into alert_state (user_id, cursor, updated_at) values (?, ?, ?)
          on conflict (user_id) do update set cursor = excluded.cursor,
                                              updated_at = excluded.updated_at`,
    args: [userId, cursor, nowIso()],
  });
}

/**
 * Move only the "last looked at" half, leaving the watermark alone.
 *
 * The round-robin in usersWithAlerts is ordered by it, so an account the sender
 * examined and found nothing for has to be marked as examined — otherwise it
 * sits at the head of the queue for ever and the accounts behind it are never
 * reached.
 *
 * @param {Client} db
 * @param {string} userId
 */
export async function touchAlertState(db, userId) {
  await db.execute({
    sql: 'update alert_state set updated_at = ? where user_id = ?',
    args: [nowIso(), userId],
  });
}

/* ------------------------------------------------------------- what is new */

/**
 * The columns an alert needs about a post.
 *
 * Narrower than the river's: an alert is a line of text and a link, so the audio
 * enclosure and the card art that a page renders are weight the sender would
 * carry across the network and throw away.
 */
const ALERT_COLS = `i.guid, i.url, i.title, i.summary, i.published_at, i.created_at,
                    i.cluster_key, f.slug as feed_slug, f.title as feed_title`;

/**
 * New posts from the blogs an account has alerting, oldest first.
 *
 * Oldest first because the watermark advances to the last row read: taking the
 * newest `limit` rows and then setting the cursor past them would skip
 * everything in between on a busy tick.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} cursor
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function newItemsFromAlertedFeeds(db, userId, cursor, limit = 50) {
  const { rows } = await db.execute({
    sql: `select ${ALERT_COLS}
          from follows fo
          join feeds f on f.id = fo.feed_id
          join feed_items i on i.feed_id = f.id
          where fo.user_id = ? and fo.alerts = 1 and i.created_at > ?
          order by i.created_at
          limit ?`,
    args: [userId, cursor, limit],
  });
  return rows;
}

/**
 * The topics an account has alerting.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function alertedTopics(db, userId, limit = 50) {
  const { rows } = await db.execute({
    sql: `select tf.slug, tf.segment,
                 (select min(k.keyword) from feed_keywords k where k.slug = tf.slug) as keyword
          from topic_follows tf
          where tf.user_id = ? and tf.alerts = 1
          order by tf.created_at desc
          limit ?`,
    args: [userId, limit],
  });
  return rows;
}

/**
 * How many feeds of a topic an alert draws from.
 *
 * Much smaller than the river's 200. The river is a page somebody is waiting on
 * once; this is a query per alerting topic per account per tick, and a topic's
 * best fifty feeds are where anything worth interrupting somebody about is
 * going to appear.
 */
export const ALERT_TOPIC_FEEDS = 50;

/**
 * New posts on one alerting topic, oldest first.
 *
 * The same `picked` shape as itemsForTopic — a topic is defined by the keyword
 * table, not by a column on the feed — but filtered on `created_at` rather than
 * windowed on `published_at`. A topic river shows the last two years; an alert
 * is about the last few minutes, and the ingest time is the only clock that
 * agrees with the watermark.
 *
 * @param {Client} db
 * @param {string} slug
 * @param {string} cursor
 * @param {{ segment?: string, limit?: number, feedCap?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function newItemsForTopic(db, slug, cursor, opts = {}) {
  const { segment = '', limit = 50, feedCap = ALERT_TOPIC_FEEDS } = opts;
  const kinds = segmentKinds(segment);
  const filter = kinds ? ` and f.category in (${kinds.map(() => '?').join(', ')})` : '';

  const { rows } = await db.execute({
    sql: `with picked as (
            select k.feed_id from feed_keywords k
            join feeds f on f.id = k.feed_id and f.status <> 'dead'
            where k.slug = ?${filter}
            order by case k.source when 'category' then 0 else 1 end, k.count desc
            limit ?
          )
          select ${ALERT_COLS}
          from feed_items i
          join feeds f on f.id = i.feed_id
          where i.feed_id in (select feed_id from picked)
            and i.created_at > ?
          order by i.created_at
          limit ?`,
    args: [slug, ...(kinds ?? []), feedCap, cursor, limit],
  });
  return rows;
}

/**
 * How many of an author's feeds an alert draws from.
 *
 * A person credited on more than this many feeds is either extremely prolific
 * or a mis-merge, and both are better bounded than trusted: the query runs once
 * per alerting author per account per tick.
 */
export const ALERT_AUTHOR_FEEDS = 20;

/**
 * The people an account has alerting.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function alertedAuthors(db, userId, limit = 50) {
  const { rows } = await db.execute({
    sql: `select a.id, a.slug, a.name
          from author_follows af join authors a on a.id = af.author_id
          where af.user_id = ? and af.alerts = 1
          order by af.created_at desc
          limit ?`,
    args: [userId, limit],
  });
  return rows;
}

/**
 * New posts by one alerting author, oldest first.
 *
 * An author is defined by `feed_authors`, so this reads their feeds rather than
 * a column on the item. Filtered on `created_at` for the same reason every
 * other alert query is: the watermark is a point in ingest time, and
 * `published_at` is whatever the publisher claimed.
 *
 * Dead feeds are excluded on the same grounds the topic query excludes them. A
 * feed that stopped resolving still carries its old items, and an author whose
 * blog moved should not have the move announced as new writing.
 *
 * @param {Client} db
 * @param {string} authorId
 * @param {string} cursor
 * @param {{ limit?: number, feedCap?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function newItemsForAuthor(db, authorId, cursor, opts = {}) {
  const { limit = 50, feedCap = ALERT_AUTHOR_FEEDS } = opts;

  const { rows } = await db.execute({
    sql: `with picked as (
            select fa.feed_id from feed_authors fa
            join feeds f on f.id = fa.feed_id and f.status <> 'dead'
            where fa.author_id = ?
            limit ?
          )
          select ${ALERT_COLS}
          from feed_items i
          join feeds f on f.id = i.feed_id
          where i.feed_id in (select feed_id from picked)
            and i.created_at > ?
          order by i.created_at
          limit ?`,
    args: [authorId, feedCap, cursor, limit],
  });
  return rows;
}

/* --------------------------------------------------------------- sent-log */

/**
 * The identity an alert is de-duplicated by.
 *
 * The cluster key where there is one, so a story syndicated across four
 * followed blogs is one alert. Otherwise the feed and guid together — a guid is
 * only unique within its own feed.
 *
 * @param {{ cluster_key?: unknown, feed_slug?: unknown, guid?: unknown }} row
 * @returns {string}
 */
export function itemKey(row) {
  const cluster = String(row.cluster_key ?? '');
  if (cluster) return `c:${cluster}`;
  return `g:${String(row.feed_slug ?? '')}\n${String(row.guid ?? '')}`;
}

/**
 * How many keys one `in (…)` list may carry.
 *
 * SQLite refuses a statement with more than 999 bound parameters, and the number
 * of keys here is the sender's read limit multiplied by its topic count — two
 * numbers that are environment variables. At their defaults the total is under
 * five hundred, but "under the limit today" is not a property worth depending
 * on when the failure mode is the whole alert pass throwing.
 */
const KEYS_PER_QUERY = 200;

/**
 * Which of these keys have already been sent to this account.
 *
 * Asked in as few queries as the parameter limit allows rather than one per key:
 * a busy pass has hundreds of them, and hundreds of round trips to a network
 * database is most of a second spent on bookkeeping.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string[]} keys
 * @returns {Promise<Set<string>>} the subset already sent
 */
export async function alreadySent(db, userId, keys) {
  if (keys.length === 0) return new Set();

  const chunks = [];
  for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
    chunks.push(keys.slice(i, i + KEYS_PER_QUERY));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      db.execute({
        sql: `select item_key from alert_sent
              where user_id = ? and item_key in (${chunk.map(() => '?').join(', ')})`,
        args: [userId, ...chunk],
      }),
    ),
  );

  return new Set(results.flatMap(({ rows }) => rows.map((row) => String(row.item_key))));
}

/**
 * Record that these have now been told.
 *
 * Written *before* the delivery rather than after it. The failure this trades
 * against is asymmetric: a send that succeeds and then fails to be recorded
 * sends again on the next tick, which is a duplicate in somebody's inbox, while
 * a send recorded and then failed is one missed post in a river they can still
 * open. Duplicates are the worse of the two.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string[]} keys
 */
export async function markSent(db, userId, keys) {
  if (keys.length === 0) return;

  const at = nowIso();
  await db.batch(
    keys.map((key) => ({
      sql: 'insert into alert_sent (user_id, item_key, sent_at) values (?, ?, ?) on conflict do nothing',
      args: [userId, key, at],
    })),
    'write',
  );
}

/**
 * How long a sent-log row is kept.
 *
 * Long enough that a feed republishing an old post does not re-alert, short
 * enough that the table stays a working set rather than a history. Thirty days
 * is well past any crawl's re-read window.
 */
const SENT_TTL_DAYS = 30;

/**
 * Drop sent-log rows nobody will consult again.
 *
 * @param {Client} db
 * @returns {Promise<number>} rows removed
 */
export async function pruneAlertSent(db) {
  const cutoff = nowIso(-SENT_TTL_DAYS * 86_400_000);
  const res = await db.execute({
    sql: 'delete from alert_sent where sent_at < ?',
    args: [cutoff],
  });
  return Number(res.rowsAffected ?? 0);
}
