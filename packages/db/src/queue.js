import { newId, nowIso } from './client.js';

/**
 * One reader's queue, in three lanes.
 *
 * The lanes are read, listen and watch, and they are the reader's answer to
 * "what is this for", not ours to a question about the file. A podcast's show
 * notes can go in the read lane and its episode in the listen lane; the same
 * post can be in both, because those are two different intentions about it.
 *
 * Everything here is scoped by user_id inside the statement rather than by a
 * check in the caller, so a forged entry id addresses somebody else's row and
 * still matches nothing.
 *
 * @typedef {import('@libsql/client').Client} Client
 * @typedef {'read'|'listen'|'watch'} Lane
 */

/** The lanes, in the order they are shown. */
export const LANES = /** @type {Lane[]} */ (['read', 'listen', 'watch']);

/**
 * @param {unknown} value
 * @returns {value is Lane}
 */
export function isLane(value) {
  return LANES.includes(/** @type {Lane} */ (String(value ?? '')));
}

/**
 * Put a post in a lane, at the end of it.
 *
 * Adding something already there is a double click rather than a second
 * intention, so it keeps its place — unless it had been finished, in which case
 * it comes back at the end of the queue. Wanting a thing again is a new
 * intention even when the row is old.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} itemId
 * @param {Lane} lane
 * @returns {Promise<string>} the entry id
 */
export async function add(db, userId, itemId, lane) {
  await db.execute({
    sql: `insert into queue_entries (id, user_id, item_id, lane, position, added_at, done_at)
          values (
            ?, ?, ?, ?,
            (select coalesce(max(position), 0) + 1 from queue_entries where user_id = ? and lane = ?),
            ?, null
          )
          on conflict (user_id, lane, item_id) do update
            set position = case when queue_entries.done_at is null
                                then queue_entries.position
                                else excluded.position end,
                done_at = null`,
    args: [newId(), userId, itemId, lane, userId, lane, nowIso()],
  });

  const { rows } = await db.execute({
    sql: 'select id from queue_entries where user_id = ? and lane = ? and item_id = ? limit 1',
    args: [userId, lane, itemId],
  });
  return String(rows[0]?.id ?? '');
}

/**
 * Put a whole running order in the queue, in the order it was handed over.
 *
 * A playlist is fifty posts and adding them one at a time is fifty round trips
 * to Turso — which on a page the reader is waiting on is the difference between
 * a button and a stall. `batch` sends them as one transactional round trip, and
 * because the statements run in order the `max(position) + 1` in each insert
 * sees the one before it: the queue ends up in the order the playlist was in,
 * rather than in whatever order fifty concurrent writes happened to land.
 *
 * Each entry carries its own lane, because a playlist is not one kind of thing:
 * a topic's media is podcasts and videos together, and they belong in listen
 * and watch respectively. Sorting that out here rather than in the caller is
 * what lets one "add all" button do the honest thing with a mixed list.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {Array<{ itemId: string, lane: Lane }>} entries
 * @returns {Promise<number>} how many rows were written
 */
export async function addMany(db, userId, entries) {
  const wanted = entries.filter((entry) => entry?.itemId && isLane(entry?.lane));
  if (wanted.length === 0) return 0;

  const now = nowIso();
  await db.batch(
    wanted.map(({ itemId, lane }) => ({
      sql: `insert into queue_entries (id, user_id, item_id, lane, position, added_at, done_at)
            values (
              ?, ?, ?, ?,
              (select coalesce(max(position), 0) + 1 from queue_entries where user_id = ? and lane = ?),
              ?, null
            )
            on conflict (user_id, lane, item_id) do update
              set position = case when queue_entries.done_at is null
                                  then queue_entries.position
                                  else excluded.position end,
                  done_at = null`,
      args: [newId(), userId, String(itemId), lane, userId, lane, now],
    })),
    'write',
  );

  return wanted.length;
}

/**
 * Take a whole running order back out again.
 *
 * The other half of the button above, and the reason it is a toggle: a reader
 * who lined up fifty episodes by accident should not have to press fifty
 * buttons — or empty the lane, which would take the rest of their queue with
 * it. Only the posts that were handed over are removed.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {Array<{ itemId: string, lane: Lane }>} entries
 * @returns {Promise<number>} how many rows went
 */
export async function removeMany(db, userId, entries) {
  const wanted = entries.filter((entry) => entry?.itemId && isLane(entry?.lane));
  if (wanted.length === 0) return 0;

  const results = await db.batch(
    wanted.map(({ itemId, lane }) => ({
      sql: 'delete from queue_entries where user_id = ? and item_id = ? and lane = ?',
      args: [userId, String(itemId), lane],
    })),
    'write',
  );

  return results.reduce((total, res) => total + Number(res?.rowsAffected ?? 0), 0);
}

/**
 * Take one entry out of the queue entirely.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} entryId
 * @returns {Promise<boolean>}
 */
export async function removeEntry(db, userId, entryId) {
  const res = await db.execute({
    sql: 'delete from queue_entries where id = ? and user_id = ?',
    args: [entryId, userId],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * Take a post out of one lane, addressed the way the buttons address it.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} itemId
 * @param {Lane} lane
 * @returns {Promise<boolean>}
 */
export async function removeItem(db, userId, itemId, lane) {
  const res = await db.execute({
    sql: 'delete from queue_entries where user_id = ? and item_id = ? and lane = ?',
    args: [userId, itemId, lane],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * Mark an entry finished, or put it back in the running order.
 *
 * Finished rather than deleted: the player marks an episode done the moment it
 * plays out, and a row that vanished at that point would take the "what did I
 * get through" answer with it — and, worse, would make an accidental skip
 * unrecoverable.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} entryId
 * @param {boolean} done
 * @returns {Promise<boolean>}
 */
export async function setDone(db, userId, entryId, done) {
  const res = await db.execute({
    sql: 'update queue_entries set done_at = ? where id = ? and user_id = ?',
    args: [done ? nowIso() : null, entryId, userId],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * Move an entry one place up or down its lane.
 *
 * A swap with the adjacent pending entry, rather than renumbering the lane.
 * Positions develop gaps as things are finished and nothing minds: they are
 * only ever read by an ORDER BY.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} entryId
 * @param {'up'|'down'} direction
 * @returns {Promise<boolean>} false when it is already at the end it was sent to
 */
export async function move(db, userId, entryId, direction) {
  const { rows } = await db.execute({
    sql: 'select lane, position from queue_entries where id = ? and user_id = ? and done_at is null limit 1',
    args: [entryId, userId],
  });
  const here = rows[0];
  if (!here) return false;

  const up = direction === 'up';
  const { rows: near } = await db.execute({
    sql: `select id, position from queue_entries
          where user_id = ? and lane = ? and done_at is null and position ${up ? '<' : '>'} ?
          order by position ${up ? 'desc' : 'asc'}
          limit 1`,
    args: [userId, String(here.lane), Number(here.position)],
  });
  const neighbour = near[0];
  if (!neighbour) return false;

  await db.execute({
    sql: 'update queue_entries set position = ? where id = ? and user_id = ?',
    args: [Number(neighbour.position), entryId, userId],
  });
  await db.execute({
    sql: 'update queue_entries set position = ? where id = ? and user_id = ?',
    args: [Number(here.position), String(neighbour.id), userId],
  });
  return true;
}

/**
 * Empty a lane — either the whole of it, or only what has been finished.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {Lane} lane
 * @param {{ doneOnly?: boolean }} [opts]
 * @returns {Promise<number>} rows removed
 */
export async function clearLane(db, userId, lane, { doneOnly = false } = {}) {
  const res = await db.execute({
    sql: `delete from queue_entries where user_id = ? and lane = ?${
      doneOnly ? ' and done_at is not null' : ''
    }`,
    args: [userId, lane],
  });
  return Number(res.rowsAffected ?? 0);
}

/**
 * A lane, in order, with everything a player or a list needs to render it.
 *
 * The media columns come along because the player is handed this list whole and
 * then has to survive a page load without asking again.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {Lane} lane
 * @param {{ done?: boolean, limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function list(db, userId, lane, { done = false, limit = 200 } = {}) {
  const { rows } = await db.execute({
    sql: `select e.id, e.lane, e.position, e.added_at, e.done_at,
                 i.id as item_id, i.guid, i.url, i.title, i.summary, i.published_at,
                 i.image_url, i.audio_url, i.audio_type, i.audio_seconds,
                 f.slug as feed_slug, f.title as feed_title,
                 f.image_url as feed_image, f.card_url as feed_card
          from queue_entries e
          join feed_items i on i.id = e.item_id
          join feeds f on f.id = i.feed_id
          where e.user_id = ? and e.lane = ? and e.done_at is ${done ? 'not null' : 'null'}
          order by ${done ? 'e.done_at desc' : 'e.position asc'}
          limit ?`,
    args: [userId, lane, limit],
  });
  return rows;
}

/**
 * How many entries are waiting in each lane.
 *
 * Always answers with all three lanes, so a caller can render the tabs without
 * checking which keys came back.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<Record<Lane, number>>}
 */
export async function counts(db, userId) {
  const { rows } = await db.execute({
    sql: `select lane, count(*) as n from queue_entries
          where user_id = ? and done_at is null group by lane`,
    args: [userId],
  });

  const out = /** @type {Record<Lane, number>} */ ({ read: 0, listen: 0, watch: 0 });
  for (const row of rows) {
    const lane = String(row.lane);
    if (isLane(lane)) out[lane] = Number(row.n ?? 0);
  }
  return out;
}

/**
 * Which lanes hold each of these posts, for one reader.
 *
 * One statement for a whole page of posts: a blog page lists fifty, and asking
 * per post would be fifty round trips to draw fifty buttons.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string[]} itemIds
 * @returns {Promise<Record<string, Lane[]>>} item id → the lanes it is waiting in
 */
export async function lanesForItems(db, userId, itemIds) {
  const ids = [...new Set(itemIds.map(String))].filter(Boolean);
  if (ids.length === 0) return {};

  const { rows } = await db.execute({
    sql: `select item_id, lane from queue_entries
          where user_id = ? and done_at is null
            and item_id in (${ids.map(() => '?').join(', ')})`,
    args: [userId, ...ids],
  });

  /** @type {Record<string, Lane[]>} */
  const out = {};
  for (const row of rows) {
    const id = String(row.item_id);
    const lane = String(row.lane);
    if (!isLane(lane)) continue;
    (out[id] ??= []).push(lane);
  }
  return out;
}
