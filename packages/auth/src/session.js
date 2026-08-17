import { accounts, nowIso } from '@rssamplifier/db';

import { newToken, hashToken } from './tokens.js';
import { SESSION_COOKIE, SESSION_MS, sessionCookieOptions } from './cookie.js';

/**
 * Sessions: the cookie, and what it is worth.
 *
 * The cookie's name and attributes live in cookie.js and are re-exported here,
 * so that every caller still reads them from one place while the request proxy can
 * import them without dragging the database in behind them.
 */

export { SESSION_COOKIE, sessionCookieOptions };

/**
 * Start a session and return the value to put in the cookie.
 *
 * The caller sets the cookie, because only it knows whether it is answering a
 * form post or a fetch — this layer has no opinion about responses.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} userId
 * @param {{ userAgent?: string|null, ipHash?: string|null }} [meta]
 * @returns {Promise<{ token: string, expiresAt: string }>}
 */
export async function startSession(db, userId, meta = {}) {
  const token = newToken();
  const expiresAt = nowIso(SESSION_MS);

  await accounts.insertSession(db, {
    tokenHash: hashToken(token),
    userId,
    expiresAt,
    userAgent: meta.userAgent ?? null,
    ipHash: meta.ipHash ?? null,
  });

  await accounts.markUserLoggedIn(db, userId);

  return { token, expiresAt };
}

/**
 * The account behind a cookie value, or null.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string|undefined|null} token
 * @returns {Promise<object|null>}
 */
export async function resolveSession(db, token) {
  if (!token) return null;
  return accounts.userBySession(db, hashToken(token));
}

/**
 * End one session.
 *
 * Only the presented session is dropped, not every session the account has:
 * signing out of a laptop should not sign out the phone.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string|undefined|null} token
 */
export async function endSession(db, token) {
  if (!token) return;
  await accounts.deleteSession(db, hashToken(token));
}
