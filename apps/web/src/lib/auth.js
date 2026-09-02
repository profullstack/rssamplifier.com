import { cookies, headers } from 'next/headers';
import { SESSION_COOKIE, resolveSession, sessionCookieOptions } from '@rssamplifier/auth';
import { hashIp } from '@rssamplifier/ingest';

import { db, siteUrl } from './db.js';
import { SIGNED_IN_HINT_COOKIE } from './session-hint.js';

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
 * Is there a session cookie at all, without resolving it?
 *
 * For the one question that does not need to know *who* is reading: whether a
 * page should tell a crawler to index it. `currentUser()` is not memoised — it
 * resolves the session against the database on every call — so a
 * `generateMetadata` that used it would quietly double the session lookups on
 * every render of that page, to answer a question that only ever needed "is
 * anybody signed in".
 *
 * Presence only, exactly as the proxy decides a tier. A forged cookie makes
 * that reader's own copy of the page non-indexable and nothing else, which is
 * not worth a query to prevent.
 *
 * @returns {Promise<boolean>}
 */
export async function hasSessionCookie() {
  const store = await cookies();
  return Boolean(store.get(SESSION_COOKIE)?.value);
}

/**
 * Put the session cookie on the response, and a hint beside it.
 *
 * The session cookie is httpOnly, which is what keeps it out of reach of a
 * script on the page — and also out of reach of the masthead, which wants to
 * know whether to offer "Sign up" without reading the session on the server and
 * making every static page in the directory dynamic. The hint holds no token and
 * grants nothing: it is deliberately readable, and the only thing it can do if
 * forged is show or hide one link.
 *
 * It carries the session's own attributes, so the two expire together.
 *
 * @param {string} token
 */
export async function setSessionCookie(token) {
  const store = await cookies();
  const options = sessionCookieOptions(siteUrl());
  store.set(SESSION_COOKIE, token, options);
  store.set(SIGNED_IN_HINT_COOKIE, '1', { ...options, httpOnly: false });
}

/**
 * Remove the session cookie, and the hint with it.
 */
export async function clearSessionCookie() {
  const store = await cookies();
  const options = sessionCookieOptions(siteUrl());
  store.set(SESSION_COOKIE, '', { ...options, maxAge: 0 });
  store.set(SIGNED_IN_HINT_COOKIE, '', { ...options, httpOnly: false, maxAge: 0 });
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
