/**
 * The name of the "somebody is signed in" cookie, on its own.
 *
 * It lives here rather than beside the code that sets it because the masthead
 * needs the name too, and everything in lib/auth.js reaches for next/headers —
 * a whole request-scoped module to learn one string.
 *
 * The cookie carries no token and grants nothing; see setSessionCookie in
 * lib/auth.js for what it is and why it is readable.
 */
export const SIGNED_IN_HINT_COOKIE = 'signed_in';
