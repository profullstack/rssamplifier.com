import { cookies, headers } from 'next/headers';
import { SESSION_COOKIE, resolveSession, sessionCookieOptions } from '@rssamplifier/auth';
import { hashIp } from '@rssamplifier/ingest';

import { db, siteUrl } from './db.js';

/**
 * Reading and writing the signed-in reader, from a request.
 *
 * Everything the directory serves is public, so this is only ever consulted to
 * decide what to offer — a follow button rather than a prompt to sign in — and
 * never to decide whether a blog may be seen.
 */

/**
 * The signed-in account, or null.
 *
 * @returns {Promise<object|null>}
 */
export async function currentUser() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    return await resolveSession(db(), token);
  } catch {
    // A database hiccup should degrade to "signed out" rather than take down a
    // page that is perfectly serviceable without an account.
    return null;
  }
}

/**
 * Put the session cookie on the response.
 *
 * @param {string} token
 */
export async function setSessionCookie(token) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(siteUrl()));
}

/**
 * Remove the session cookie.
 */
export async function clearSessionCookie() {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', { ...sessionCookieOptions(siteUrl()), maxAge: 0 });
}

/**
 * @returns {Promise<string|undefined>}
 */
export async function sessionToken() {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

/**
 * Caller metadata recorded against a session, for the reader's own review.
 *
 * The address is hashed rather than stored: knowing two sessions came from the
 * same place is enough to spot a stranger, and the raw address adds nothing but
 * liability.
 *
 * @returns {Promise<{ userAgent: string|null, ipHash: string|null }>}
 */
export async function requestMeta() {
  const list = await headers();
  const ip =
    list.get('x-forwarded-for')?.split(',')[0]?.trim() || list.get('x-real-ip') || null;

  return {
    userAgent: list.get('user-agent')?.slice(0, 300) ?? null,
    ipHash: hashIp(ip, process.env['IP_HASH_SALT']),
  };
}
