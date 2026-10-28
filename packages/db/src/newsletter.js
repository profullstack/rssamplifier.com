import { randomBytes } from 'node:crypto';

import { nowIso } from './client.js';

/**
 * The weekly digest's storage: who is on it, what each week said, and who a
 * week has been sent to.
 *
 * Being on the list is a column on `users` (1 by default, the owner's call)
 * rather than a list of its own, so there is no second copy of an address to
 * fall out of step with the account. The unsubscribe link carries the
 * account id and a random token; neither the web nor the poller needs a
 * shared secret to make or check one.
 *
 * @typedef {import('@libsql/client').Client} Client
 * @typedef {{ week: string, subject: string, text: string, html: string, data: object, created_at: string, finished_at: string|null, sent_count: number }} Issue
 */

/**
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<boolean|null>} null when there is no such account
 */
export async function subscribed(db, userId) {
  const { rows } = await db.execute({
    sql: 'select newsletter from users where id = ? limit 1',
    args: [userId],
  });
  if (!rows[0]) return null;
  return Number(rows[0].newsletter) === 1;
}

/**
 * @param {Client} db
 * @param {string} userId
 * @param {boolean} on
 * @returns {Promise<boolean>} whether the account exists
 */
export async function setSubscribed(db, userId, on) {
  const { rows } = await db.execute({
    sql: 'update users set newsletter = ? where id = ? returning id',
    args: [on ? 1 : 0, userId],
  });
  return rows.length > 0;
}

/**
 * The account an unsubscribe link names, if its token is the account's.
 *
 * Compared in the database on both values at once, so a wrong token and a
 * wrong id are the same miss.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} token
 * @returns {Promise<{ id: string, email: string, subscribed: boolean }|null>}
 */
export async function userForToken(db, userId, token) {
  if (!userId || !token || token.length < 20) return null;
  const { rows } = await db.execute({
    sql: 'select id, email, newsletter from users where id = ? and newsletter_token = ? limit 1',
    args: [String(userId), String(token)],
  });
  const row = rows[0];
  if (!row) return null;
  return { id: String(row.id), email: String(row.email), subscribed: Number(row.newsletter) === 1 };
}

/**
 * The account's unsubscribe token, made on first use.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<string>}
 */
export async function tokenFor(db, userId) {
  const fresh = randomBytes(18).toString('base64url');
  const { rows } = await db.execute({
    sql: `update users set newsletter_token = coalesce(newsletter_token, ?)
           where id = ? returning newsletter_token`,
    args: [fresh, userId],
  });
  return String(rows[0]?.newsletter_token ?? '');
}

/**
 * How many accounts are on the list, and how many there are.
 *
 * @param {Client} db
 * @returns {Promise<{ subscribers: number, accounts: number }>}
 */
export async function listSize(db) {
  const { rows } = await db.execute({
    sql: 'select count(*) filter (where newsletter = 1) as subscribers, count(*) as accounts from users',
    args: [],
  });
  return { subscribers: Number(rows[0]?.subscribers ?? 0), accounts: Number(rows[0]?.accounts ?? 0) };
}

/**
 * Subscribers a week has not been addressed to yet, oldest account first.
 *
 * @param {Client} db
 * @param {string} week
 * @param {number} limit
 * @returns {Promise<Array<{ id: string, email: string }>>}
 */
export async function pendingFor(db, week, limit) {
  const { rows } = await db.execute({
    sql: `select u.id, u.email from users u
           where u.newsletter = 1
             and not exists (select 1 from newsletter_sends s where s.week = ? and s.user_id = u.id)
           order by u.created_at asc, u.id asc
           limit ?`,
    args: [week, limit],
  });
  return rows.map((r) => ({ id: String(r.id), email: String(r.email) }));
}

/**
 * Claim one reader for a week. False when the row already exists, which is
 * how a second poller (or a restarted one) never mails anybody twice.
 *
 * @param {Client} db
 * @param {string} week
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function claimSend(db, week, userId) {
  const { rows } = await db.execute({
    sql: `insert into newsletter_sends (week, user_id, status, at) values (?, ?, 'sending', ?)
          on conflict do nothing returning user_id`,
    args: [week, userId, nowIso()],
  });
  return rows.length > 0;
}

/**
 * @param {Client} db
 * @param {string} week
 * @param {string} userId
 * @param {{ ok: boolean, error?: string }} outcome
 */
export async function finishSend(db, week, userId, outcome) {
  await db.execute({
    sql: 'update newsletter_sends set status = ?, at = ?, error = ? where week = ? and user_id = ?',
    args: [outcome.ok ? 'sent' : 'failed', nowIso(), outcome.ok ? null : String(outcome.error ?? 'failed').slice(0, 300), week, userId],
  });
}

/**
 * @param {Client} db
 * @param {string} week
 * @returns {Promise<Issue|null>}
 */
export async function issueFor(db, week) {
  const { rows } = await db.execute({
    sql: 'select * from newsletter_issues where week = ? limit 1',
    args: [week],
  });
  return rows[0] ? shapeIssue(rows[0]) : null;
}

/**
 * The newest issue that has started going out.
 *
 * @param {Client} db
 * @returns {Promise<Issue|null>}
 */
export async function latestIssue(db) {
  const { rows } = await db.execute({
    sql: 'select * from newsletter_issues order by week desc limit 1',
    args: [],
  });
  return rows[0] ? shapeIssue(rows[0]) : null;
}

/**
 * Store a week's issue once. A second build for the same week keeps the first,
 * so every reader of a week gets the same mail.
 *
 * @param {Client} db
 * @param {{ week: string, subject: string, text: string, html: string, data: object }} issue
 * @returns {Promise<Issue>}
 */
export async function saveIssue(db, issue) {
  await db.execute({
    sql: `insert into newsletter_issues (week, subject, text, html, data, created_at)
          values (?, ?, ?, ?, ?, ?) on conflict (week) do nothing`,
    args: [issue.week, issue.subject, issue.text, issue.html, JSON.stringify(issue.data ?? {}), nowIso()],
  });
  return /** @type {Issue} */ (await issueFor(db, issue.week));
}

/**
 * Bring a week's counters up to date, and close it when nobody is left.
 *
 * @param {Client} db
 * @param {string} week
 * @param {boolean} done
 */
export async function closeIssue(db, week, done) {
  await db.execute({
    sql: `update newsletter_issues
             set sent_count = (select count(*) from newsletter_sends s where s.week = ? and s.status = 'sent'),
                 finished_at = case when ? = 1 then coalesce(finished_at, ?) else finished_at end
           where week = ?`,
    args: [week, done ? 1 : 0, nowIso(), week],
  });
}

/**
 * Per-status counts for a week.
 *
 * @param {Client} db
 * @param {string} week
 * @returns {Promise<Record<string, number>>}
 */
export async function sendCounts(db, week) {
  const { rows } = await db.execute({
    sql: 'select status, count(*) as n from newsletter_sends where week = ? group by status',
    args: [week],
  });
  return Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
}

/**
 * What a week's digest is made of, read from the directory.
 *
 * Four small reads, each bounded and each on an index: feeds that joined this
 * week and published this week; the newest post from each of the most
 * followed feeds; posts readers liked or voted for; and the rings people used,
 * with the sites that joined one. Any of them may be empty; the renderer drops
 * an empty section rather than printing a heading over nothing.
 *
 * @param {Client} db
 * @param {{ since: string, limit?: number }} opts
 */
export async function digestData(db, { since, limit = 8 }) {
  const [newFeeds, newCount, followed, liked, rings, joined] = await Promise.all([
    db.execute({
      sql: `select slug, title, site_url, description from feeds
             where created_at >= ? and status = 'active' and social_network is null
               and last_published_at >= ? and item_count > 0
             order by item_count desc, created_at desc
             limit ?`,
      args: [since, since, limit],
    }),
    db.execute({
      sql: `select count(*) as n from feeds where created_at >= ? and status = 'active'`,
      args: [since],
    }),
    db.execute({
      sql: `select f.slug as feed_slug, f.title as feed_title, i.title, i.url, i.published_at, t.followers
              from (select feed_id, count(*) as followers from follows group by feed_id
                     order by count(*) desc limit 40) t
              join feeds f on f.id = t.feed_id
              cross join lateral (
                select title, url, published_at from feed_items
                 where feed_id = t.feed_id and published_at >= ?
                 order by published_at desc limit 1) i
             order by t.followers desc, i.published_at desc
             limit ?`,
      args: [since, limit],
    }),
    db.execute({
      sql: `select f.slug as feed_slug, f.title as feed_title, i.title, i.url,
                   sum(r.liked + greatest(r.vote, 0)) as score
              from post_reactions r
              join feed_items i on i.id = r.item_id
              join feeds f on f.id = i.feed_id
             where r.updated_at >= ?
             group by f.slug, f.title, i.id, i.title, i.url
            having sum(r.liked + greatest(r.vote, 0)) > 0
             order by score desc
             limit ?`,
      args: [since, limit],
    }),
    db.execute({
      sql: `select e.ring_slug as slug, coalesce(r.title, e.ring_slug) as title, count(*) as events
              from ring_events e
              left join rings r on r.slug = e.ring_slug
             where e.created_at >= ? and (r.public is null or r.public = 1)
             group by e.ring_slug, r.title
             order by count(*) desc
             limit 5`,
      args: [since],
    }),
    db.execute({
      sql: `select m.ring_slug, coalesce(r.title, m.ring_slug) as ring_title, f.title, m.site_url
              from ring_members m
              join rings r on r.slug = m.ring_slug
              join feeds f on f.id = m.feed_id
             where m.joined_at >= ? and r.public = 1 and r.kind = 'curated'
             order by m.joined_at desc
             limit ?`,
      args: [since, limit],
    }),
  ]);

  const plain = (/** @type {{ rows: any[] }} */ r) => r.rows.map((row) => ({ ...row }));
  return {
    newFeeds: plain(newFeeds),
    newFeedCount: Number(newCount.rows[0]?.n ?? 0),
    followed: plain(followed),
    liked: plain(liked),
    rings: plain(rings),
    joined: plain(joined),
  };
}

/** @param {any} row @returns {Issue} */
function shapeIssue(row) {
  let data = {};
  try {
    data = JSON.parse(String(row.data ?? '{}'));
  } catch {
    data = {};
  }
  return {
    week: String(row.week),
    subject: String(row.subject),
    text: String(row.text),
    html: String(row.html),
    data,
    created_at: String(row.created_at),
    finished_at: row.finished_at ? String(row.finished_at) : null,
    sent_count: Number(row.sent_count ?? 0),
  };
}
