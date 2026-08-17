import { SESSION_COOKIE, sessionCookieOptions } from '@rssamplifier/auth/cookie';

/**
 * The "somebody is signed in" cookie: its name, and putting it back.
 *
 * The name lives here rather than beside the code that sets it because the
 * masthead needs it too, and everything in lib/auth.js reaches for next/headers
 * — a whole request-scoped module to learn one string.
 *
 * The cookie carries no token and grants nothing; see setSessionCookie in
 * lib/auth.js for what it is and why it is readable.
 *
 * Nothing here imports next/server, so the decision can be tested as the plain
 * function it is; proxy.js is the four lines that turn it into a response.
 */

export const SIGNED_IN_HINT_COOKIE = 'signed_in';

/**
 * The cookie attributes to restore the hint with, or null to leave it alone.
 *
 * The masthead decides whether to offer "Sign up" from this readable cookie set
 * beside the session, because reading the session itself would make every
 * static page in the directory dynamic. That works for as long as the two stay
 * together — and they are written and cleared together — but there are two ways
 * for a session to outlive its hint:
 *
 * - It was created before the hint existed. Sessions last thirty days, so those
 *   readers saw "Sign up" in the nav for a month after signing in.
 * - The hint is deliberately readable, which also means deliberately erasable: a
 *   privacy extension or a "clear site data" sweep that leaves httpOnly cookies
 *   alone takes this one and nothing else.
 *
 * Neither repaired itself, because nothing on the site ever looked again.
 *
 * This matches on the session cookie's *presence* and never resolves it — no
 * database, no token handling, just a name. That is as accurate as the thing it
 * restores: the hint has always meant "a session cookie was issued to this
 * browser" rather than "the session is still valid", and a session revoked
 * elsewhere already leaves both cookies in place until they expire. The hint
 * grants nothing, so the worst a wrong one can do is offer a link to /account
 * that redirects to /login.
 *
 * @param {{ cookies: { get: (name: string) => { value: string }|undefined }, headers: { get: (name: string) => string|null }, nextUrl: { protocol: string } }} request
 * @returns {{ httpOnly: false, sameSite: 'lax', secure: boolean, path: string, maxAge: number }|null}
 */
export function hintToRestore(request) {
  const signedIn = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const hinted = request.cookies.get(SIGNED_IN_HINT_COOKIE)?.value === '1';
  if (!signedIn || hinted) return null;

  // The scheme comes off the request rather than out of SITE_URL: this runs in
  // the edge runtime, where `process.env` is fixed at build time, and the app is
  // served behind Railway's proxy — so the forwarded header is both the value
  // that is actually true and the only one that is certainly present. Getting it
  // wrong would mark the cookie Secure on a plain-http development server, where
  // the browser drops it and the repair silently never lands.
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = forwarded || String(request.nextUrl.protocol).replace(':', '');

  // The session's own attributes, minus httpOnly — the same shape
  // setSessionCookie writes, so the repaired hint expires no later than the
  // session it describes.
  return { ...sessionCookieOptions(`${scheme}://`), httpOnly: false };
}
