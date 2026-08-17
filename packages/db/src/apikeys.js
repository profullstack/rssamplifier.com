import { newId, nowIso } from './client.js';

/**
 * Storage for the keys that raise a caller's rate limit.
 *
 * Nothing here grants access to anything: every endpoint the API exposes
 * answers without a key. A key only says who is asking, so that a caller who
 * identifies themselves can be trusted with more requests than an anonymous one.
 *
 * @typedef {import('@libsql/client').Client} Client
 */

const KEY_COLS = `id, user_id, name, prefix, hourly_limit, created_at, last_used_at, revoked_at`;

/**
 * How many live keys one account may hold.
 *
 * A cap rather than a policy: keys are free and creating them is a single POST,
 * so without one an account can fill the table. Ten is far more than the "one
 * per machine" that anybody actually needs.
 */
export const MAX_KEYS_PER_USER = 10;

/**
 * Store a freshly minted key.
 *
 * Takes the hash, never the token — the caller mints it and hands the plain
 * value straight to its owner, so this module never sees a usable credential.
 *
 * @param {Client} db
 * @param {{ userId: string, name: string, prefix: string, hash: string, hourlyLimit?: number }} key
 * @returns {Promise<{ id: string }>}
 */
export async function insertKey(db, key) {
  const id = newId();
  await db.execute({
    sql: `insert into api_keys (id, user_id, name, prefix, token_hash, hourly_limit, created_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      key.userId,
      key.name || 'api key',
      key.prefix,
      key.hash,
      key.hourlyLimit ?? 5000,
      nowIso(),
    ],
  });
  return { id };
}

/**
 * An account's keys, newest first. Never includes the hashes.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function keysForUser(db, userId) {
  const { rows } = await db.execute({
    sql: `select ${KEY_COLS} from api_keys where user_id = ? order by created_at desc`,
    args: [userId],
  });
  return rows;
}

/**
 * How many keys an account still has in service.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function liveKeyCount(db, userId) {
  const { rows } = await db.execute({
    sql: `select count(*) as n from api_keys where user_id = ? and revoked_at is null`,
    args: [userId],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Look up a presented key by its hash.
 *
 * Returns null for a revoked key as firmly as for an unknown one: the caller
 * must not be able to tell "this key was cancelled" from "this key never
 * existed", because the first answer confirms a guess.
 *
 * @param {Client} db
 * @param {string} hash
 * @returns {Promise<object|null>}
 */
export async function keyByHash(db, hash) {
  const { rows } = await db.execute({
    sql: `select ${KEY_COLS} from api_keys where token_hash = ? and revoked_at is null limit 1`,
    args: [hash],
  });
  return rows[0] ?? null;
}

/**
 * Record that a key was used.
 *
 * Deliberately coarse — only when the stored timestamp is over an hour old.
 * "Last used" is here so somebody can find the key they forgot they issued, and
 * that question is not answered any better by a write on every single request.
 *
 * @param {Client} db
 * @param {string} id
 * @param {string|null} lastUsedAt
 * @returns {Promise<void>}
 */
export async function touchKey(db, id, lastUsedAt) {
  const seen = lastUsedAt ? Date.parse(String(lastUsedAt)) : 0;
  if (Number.isFinite(seen) && Date.now() - seen < 3_600_000) return;

  await db.execute({
    sql: `update api_keys set last_used_at = ? where id = ?`,
    args: [nowIso(), id],
  });
}

/**
 * Withdraw a key. Scoped to its owner, so an id alone is not enough to cancel
 * somebody else's.
 *
 * @param {Client} db
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<boolean>} whether a live key was revoked
 */
export async function revokeKey(db, id, userId) {
  const res = await db.execute({
    sql: `update api_keys set revoked_at = ?
          where id = ? and user_id = ? and revoked_at is null`,
    args: [nowIso(), id, userId],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}
