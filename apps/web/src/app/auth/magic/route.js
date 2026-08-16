import { consumeSignInLink, startSession } from '@rssamplifier/auth';

import { db, siteUrl } from '../../../lib/db.js';
import { setSessionCookie, requestMeta } from '../../../lib/auth.js';

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
  const token = new URL(req.url).searchParams.get('t');
  const result = await consumeSignInLink(db(), token ?? '');

  if (!result.ok) {
    return redirect(`/login?error=${encodeURIComponent(result.error)}`);
  }

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
