import { newId, nowIso } from './client.js';

/**
 * Likes, votes and comments on a post.
 *
 * @typedef {import('@libsql/client').Client} Client
 */

/** Longest comment accepted. Long enough for a paragraph of reply, short
 * enough that a single row cannot be used as free hosting. */
export const COMMENT_MAX = 4000;

/* -------------------------------------------------------------- reactions */

/**
 * Set the like flag on a post, leaving any vote alone.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} itemId
 * @param {boolean} liked
 */
export async function setLike(db, userId, itemId, liked) {
  const now = nowIso();
  await db.execute({
    sql: `insert into post_reactions (user_id, item_id, liked, vote, created_at, updated_at)
          values (?, ?, ?, 0, ?, ?)
          on conflict (user_id, item_id)
          do update set liked = excluded.liked, updated_at = excluded.updated_at`,
    args: [userId, itemId, liked ? 1 : 0, now, now],
  });
}

/**
 * Set the vote on a post, leaving any like alone.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} itemId
 * @param {-1|0|1} vote
 */
export async function setVote(db, userId, itemId, vote) {
  const now = nowIso();
  await db.execute({
    sql: `insert into post_reactions (user_id, item_id, liked, vote, created_at, updated_at)
          values (?, ?, 0, ?, ?, ?)
          on conflict (user_id, item_id)
          do update set vote = excluded.vote, updated_at = excluded.updated_at`,
    args: [userId, itemId, vote, now, now],
  });
}

/**
 * What one reader has done to one post.
 *
 * Returns the neutral state rather than null when there is no row, so callers
 * render buttons the same way for a first-time visitor as for a returning one.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} itemId
 * @returns {Promise<{ liked: boolean, vote: number }>}
 */
export async function reactionFor(db, userId, itemId) {
  const { rows } = await db.execute({
    sql: 'select liked, vote from post_reactions where user_id = ? and item_id = ? limit 1',
    args: [userId, itemId],
  });
  const row = rows[0];
  return { liked: Number(row?.liked ?? 0) === 1, vote: Number(row?.vote ?? 0) };
}

/**
 * The public score of a post: ups, downs and their sum.
 *
 * @param {Client} db
 * @param {string} itemId
 * @returns {Promise<{ score: number, up: number, down: number }>}
 */
export async function scoreFor(db, itemId) {
  const { rows } = await db.execute({
    sql: `select
            coalesce(sum(case when vote = 1 then 1 else 0 end), 0) as up,
            coalesce(sum(case when vote = -1 then 1 else 0 end), 0) as down
          from post_reactions where item_id = ? and vote <> 0`,
    args: [itemId],
  });
  const up = Number(rows[0]?.up ?? 0);
  const down = Number(rows[0]?.down ?? 0);
  return { score: up - down, up, down };
}

/**
 * Everything a reader has liked, newest first — the /favorites shelf.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function likedItems(db, userId, limit = 200) {
  const { rows } = await db.execute({
    sql: `select i.guid, i.url, i.title, i.summary, i.published_at,
                 f.slug as feed_slug, f.title as feed_title,
                 r.updated_at as liked_at
          from post_reactions r
          join feed_items i on i.id = r.item_id
          join feeds f on f.id = i.feed_id
          where r.user_id = ? and r.liked = 1
          order by r.updated_at desc
          limit ?`,
    args: [userId, limit],
  });
  return rows;
}

/**
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function countLikes(db, userId) {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from post_reactions where user_id = ? and liked = 1',
    args: [userId],
  });
  return Number(rows[0]?.n ?? 0);
}

/* --------------------------------------------------------------- comments */

/**
 * Post a comment. The body is trimmed and capped; an empty one is refused
 * rather than stored, so the thread never shows a blank bubble.
 *
 * @param {Client} db
 * @param {string} itemId
 * @param {string} userId
 * @param {string} body
 * @returns {Promise<string|null>} the new comment id, or null if the body was empty
 */
export async function addComment(db, itemId, userId, body) {
  const text = String(body ?? '').trim().slice(0, COMMENT_MAX);
  if (!text) return null;

  const id = newId();
  await db.execute({
    sql: `insert into comments (id, item_id, user_id, body, created_at)
          values (?, ?, ?, ?, ?)`,
    args: [id, itemId, userId, text, nowIso()],
  });
  return id;
}

/**
 * The thread on a post, oldest first.
 *
 * Deleted comments come back as rows with a null body rather than being
 * filtered out, so the page can show the gap honestly.
 *
 * @param {Client} db
 * @param {string} itemId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function commentsFor(db, itemId, limit = 200) {
  const { rows } = await db.execute({
    sql: `select c.id, c.user_id, c.created_at, c.deleted_at,
                 case when c.deleted_at is null then c.body else null end as body,
                 u.email
          from comments c join users u on u.id = c.user_id
          where c.item_id = ?
          order by c.created_at asc
          limit ?`,
    args: [itemId, limit],
  });
  return rows;
}

/**
 * @param {Client} db
 * @param {string} itemId
 * @returns {Promise<number>}
 */
export async function countComments(db, itemId) {
  const { rows } = await db.execute({
    sql: 'select count(*) as n from comments where item_id = ? and deleted_at is null',
    args: [itemId],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Delete one's own comment. Scoped by user_id in the statement itself, so a
 * forged id cannot remove somebody else's.
 *
 * @param {Client} db
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function deleteComment(db, id, userId) {
  const res = await db.execute({
    sql: 'update comments set deleted_at = ? where id = ? and user_id = ? and deleted_at is null',
    args: [nowIso(), id, userId],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}
