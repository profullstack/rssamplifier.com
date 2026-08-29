import { consumeSignInLink, startSession } from '@rssamplifier/auth';

import { db, siteUrl } from '../../../lib/db.js';
import { setSessionCookie, requestMeta } from '../../../lib/auth.js';
import { attempt, forgive, callerAddress } from '../../../lib/authThrottle.js';

export const dynamic = 'force-dynamic';

/**
 * Land on a sign-in link.
 *
 * A GET that changes state, which is normally worth avoiding — but this is the
 * one case where the request is made by a mail client following a link, so
 * there is nothing else it could be.
 *
 * The token is spent whether or not the rest succeeds, which is what stops a
 * link being replayed from a mail provider's link-scanner and then again by the
 * reader.
 *
 * @param {Request} req
 */
export async function GET(req) {
  // Presenting a token that does not work is the nearest thing this system has
  // to a failed login, so it is what the backoff counts. Guessing one is not a
  // realistic attack — a token is 32 random bytes — but a caller grinding this
  // endpoint is doing nothing legitimate either, and metering it costs a real
  // reader nothing: their link works the first time.
  const caller = callerAddress(req);
  const identity = `magic-verify:${caller}`;

  const verdict = attempt(identity);
  if (!verdict.ok) {
    return redirect(`/login?error=too-many&retry=${verdict.retryAfter}`);
  }

  const token = new URL(req.url).searchParams.get('t');
  const result = await consumeSignInLink(db(), token ?? '');

  if (!result.ok) {
    return redirect(`/login?error=${encodeURIComponent(result.error)}`);
  }

  // It worked, so whoever this is can read the mailbox — which is the whole
  // security model. Any fumbled links before it were a person, not an attack.
  forgive(identity);

  const meta = await requestMeta();
  const { token: sessionToken } = await startSession(db(), result.userId, meta);
  await setSessionCookie(sessionToken);

  // A first sign-in goes somewhere that explains passkeys; a returning reader
  // goes to what they came back for.
  return redirect(result.created ? '/account?welcome=1' : '/account');
}

/**
 * @param {string} location
 * @returns {Response}
 */
function redirect(location) {
  return new Response(null, {
    status: 303,
    headers: { location: `${siteUrl()}${location}`, 'cache-control': 'no-store' },
  });
}
