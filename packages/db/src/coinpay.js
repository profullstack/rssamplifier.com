import { newId, nowIso } from './client.js';
import { normalizeEmail } from './accounts.js';

/**
 * Sign in with CoinPay: what it reads and writes.
 *
 * Bound by `sub` only (the STANDING rule): nothing here looks an account up by
 * the CoinPay email, and the CoinPay email never reaches users.email.
 *
 * @typedef {import('./pg.js').PgClient} Client
 */

/** Accounts made by CoinPay carry an address that cannot receive mail. */
export const PLACEHOLDER_DOMAIN = 'coinpay.invalid';

/**
 * @param {unknown} email
 * @returns {boolean}
 */
export function isPlaceholderEmail(email) {
  return normalizeEmail(email).endsWith(`@${PLACEHOLDER_DOMAIN}`);
}

/* --------------------------------------------------------- requests in flight */

/**
 * @param {Client} db
 * @param {{ id: string, verifier: string, nonce: string, next: string, linkUserId: string|null, expiresAt: string }} row
 */
export async function insertPending(db, row) {
  await db.execute({ sql: 'delete from coinpay_pending where expires_at <= ?', args: [nowIso()] });
  await db.execute({
    sql: `insert into coinpay_pending (id, verifier, nonce, next_path, link_user_id, expires_at, created_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
    args: [row.id, row.verifier, row.nonce, row.next, row.linkUserId, row.expiresAt, nowIso()],
  });
}

/**
 * Spend a pending request. The delete is the check, so two callbacks with the
 * same state race in the database and only one of them gets the row.
 *
 * @param {Client} db
 * @param {string} id
 * @returns {Promise<{ verifier: string, nonce: string, next: string, linkUserId: string|null }|null>}
 */
export async function takePending(db, id) {
  const { rows } = await db.execute({
    sql: `delete from coinpay_pending where id = ? and expires_at > ?
          returning verifier, nonce, next_path, link_user_id`,
    args: [id, nowIso()],
  });
  const row = rows[0];
  if (!row) return null;
  return {
    verifier: String(row.verifier),
    nonce: String(row.nonce),
    next: String(row.next_path),
    linkUserId: row.link_user_id == null ? null : String(row.link_user_id),
  };
}

/* ---------------------------------------------------------------- identities */

/**
 * @param {Client} db
 * @param {string} sub
 */
export async function identityBySub(db, sub) {
  const { rows } = await db.execute({
    sql: 'select sub, user_id, email, name, created_at from coinpay_identities where sub = ? limit 1',
    args: [sub],
  });
  return rows[0] ?? null;
}

/**
 * @param {Client} db
 * @param {string} userId
 */
export async function identityForUser(db, userId) {
  const { rows } = await db.execute({
    sql: 'select sub, user_id, email, name, created_at from coinpay_identities where user_id = ? limit 1',
    args: [userId],
  });
  return rows[0] ?? null;
}

/**
 * @param {Client} db
 * @param {{ sub: string, userId: string, email: string|null, name: string|null }} identity
 */
export async function insertIdentity(db, identity) {
  await db.execute({
    sql: `insert into coinpay_identities (sub, user_id, email, name, created_at, last_login_at)
          values (?, ?, ?, ?, ?, ?)`,
    args: [identity.sub, identity.userId, identity.email, identity.name, nowIso(), nowIso()],
  });
}

/**
 * @param {Client} db
 * @param {{ sub: string, email: string|null, name: string|null }} identity
 */
export async function touchIdentity(db, identity) {
  await db.execute({
    sql: 'update coinpay_identities set last_login_at = ?, email = ?, name = ? where sub = ?',
    args: [nowIso(), identity.email, identity.name, identity.sub],
  });
}

/**
 * @param {Client} db
 * @param {string} userId
 */
export async function deleteIdentityForUser(db, userId) {
  await db.execute({ sql: 'delete from coinpay_identities where user_id = ?', args: [userId] });
}

/**
 * A new account for a CoinPay identity, on a placeholder address and off the
 * weekly digest (there is nowhere to send it).
 *
 * @param {Client} db
 * @param {string} placeholder
 * @returns {Promise<{ id: string, email: string }>}
 */
export async function insertPlaceholderUser(db, placeholder) {
  const id = newId();
  const email = normalizeEmail(placeholder);
  await db.execute({
    sql: 'insert into users (id, email, created_at, newsletter) values (?, ?, ?, 0)',
    args: [id, email, nowIso()],
  });
  return { id, email };
}

/**
 * Give a placeholder account a real, proven address. Only while it is still on
 * the placeholder and the address is free; false otherwise.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} email
 * @returns {Promise<boolean>}
 */
export async function adoptEmail(db, userId, email) {
  const normalized = normalizeEmail(email);
  try {
    const { rows } = await db.execute({
      sql: `update users set email = ?
            where id = ? and email like ?
              and not exists (select 1 from users other where other.email = ?)
            returning id`,
      args: [normalized, userId, `%@${PLACEHOLDER_DOMAIN}`, normalized],
    });
    return rows.length === 1;
  } catch {
    // The unique index lost a race with a sign-in link for the same address.
    return false;
  }
}
