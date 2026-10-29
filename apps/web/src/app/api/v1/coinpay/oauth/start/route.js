import { cookies } from 'next/headers';
import { authorizeUrl, pkce, randomToken, SIGN_IN_SCOPES } from '@profullstack/coinpay-onboard/oauth';
import { COINPAY_PENDING_MS, saveCoinpayPending } from '@rssamplifier/auth';

import { db } from '../../../../../../lib/db.js';
import { currentUser } from '../../../../../../lib/auth.js';
import { STATE_COOKIE, STATE_COOKIE_PATH, coinpayConfig, seeOther } from '../../../../../../lib/coinpay.js';

export const dynamic = 'force-dynamic';

/**
 * Start "Sign in with CoinPay" (or, with ?link=1, "Connect CoinPay" from the
 * account page). PKCE S256, state and nonce; the verifier and nonce stay in
 * coinpay_pending, and state is pinned to this browser by an httpOnly cookie.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const config = coinpayConfig();
  if (!config) return seeOther('/login');

  const params = new URL(req.url).searchParams;
  let linkUserId = null;
  if (params.get('link') === '1') {
    // Connecting happens only from inside the account it joins.
    const user = await currentUser();
    if (!user) return seeOther('/login?next=%2Faccount');
    linkUserId = String(user.id);
  }

  const state = randomToken();
  const nonce = randomToken();
  const { verifier, challenge } = pkce();
  await saveCoinpayPending(db(), state, {
    verifier,
    nonce,
    next: params.get('next') ?? '/account',
    linkUserId,
  });

  const store = await cookies();
  store.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.redirectUri.startsWith('https:'),
    path: STATE_COOKIE_PATH,
    maxAge: Math.floor(COINPAY_PENDING_MS / 1000),
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state,
        challenge,
        nonce,
        scopes: SIGN_IN_SCOPES,
      }),
      'cache-control': 'no-store',
    },
  });
}
