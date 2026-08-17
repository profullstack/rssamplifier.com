/**
 * The session cookie's name and attributes, with nothing behind them.
 *
 * Split out of session.js so that code which only needs to *recognise* a
 * session cookie does not have to import the code that issues one. session.js
 * reaches for the database on the first line; the middleware that repairs the
 * signed-in hint runs on every request and must stay a string comparison, so it
 * imports this and nothing else. session.js re-exports both names, which is
 * where the rest of the app still reads them from.
 */

export const SESSION_COOKIE = 'rsa_session';

/** Thirty days. Long enough that a reader is not asked to prove themselves weekly. */
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

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
