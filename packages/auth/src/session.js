import { accounts, nowIso } from '@rssamplifier/db';

import { newToken, hashToken } from './tokens.js';

/**
 * Sessions: the cookie, and what it is worth.
 */

export const SESSION_COOKIE = 'rsa_session';

/** Thirty days. Long enough that a reader is not asked to prove themselves weekly. */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * Cookie attributes for the session.
 *
 * `secure` follows the site URL rather than being hardcoded, so a local http
 * development server can still hold a session — a Secure cookie is simply
 * dropped over plain http, which would make sign-in appear to do nothing.
 *
 * @param {string} siteUrl
 * @returns {{ httpOnly: boolean, sameSite: 'lax', secure: boolean, path: string, maxAge: number }}
 */
export function sessionCookieOptions(siteUrl) {
  return {
    httpOnly: true,
    // Lax, not Strict: the sign-in link arrives from a mail client, and a Strict
    // cookie would not be sent on that first cross-site navigation — the reader
    // would land signed out immediately after signing in.
    sameSite: 'lax',
    secure: String(siteUrl).startsWith('https://'),
    path: '/',
    maxAge: Math.floor(SESSION_MS / 1000),
  };
}
