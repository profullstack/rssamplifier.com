import { cookies } from 'next/headers';
import { finishSignIn } from '@profullstack/coinpay-onboard/oauth';
import { signInWithCoinpay, startSession, takeCoinpayCallback } from '@rssamplifier/auth';

import { db } from '../../../../../../lib/db.js';
import { currentUser, requestMeta, setSessionCookie } from '../../../../../../lib/auth.js';
import { STATE_COOKIE, STATE_COOKIE_PATH, coinpayConfig, seeOther } from '../../../../../../lib/coinpay.js';

export const dynamic = 'force-dynamic';

/**
 * Finish "Sign in with CoinPay".
 *
 * Refused before the code is exchanged when the state is not the one this
 * browser started, was already used, or (for Connect CoinPay) the session is
 * not the one that asked. The exchange sends the PKCE verifier and the client
 * secret; the id_token's issuer, audience, expiry and nonce are checked, and
 * userinfo's sub must match it (@profullstack/coinpay-onboard).
 *
 * @param {Request} req
 */
export async function GET(req) {
  const config = coinpayConfig();
  if (!config) return seeOther('/login');

  const params = new URL(req.url).searchParams;
  const store = await cookies();
  const cookieState = store.get(STATE_COOKIE)?.value;
  store.set(STATE_COOKIE, '', { path: STATE_COOKIE_PATH, maxAge: 0 });

  const user = await currentUser();
  const checked = await takeCoinpayCallback(db(), {
    state: params.get('state'),
    cookieState,
    sessionUserId: user ? String(user.id) : null,
  });
  if (!checked.ok) return seeOther(`/login?error=coinpay-${checked.error}`);
  const { pending } = checked;
  const linking = pending.linkUserId !== null;

  const code = params.get('code');
  if (params.get('error') || !code) {
    return seeOther(linking ? '/account?coinpay=cancelled#coinpay' : '/login?error=coinpay-cancelled');
  }

  let profile;
  try {
    const result = await finishSignIn({
      code,
      verifier: pending.verifier,
      nonce: pending.nonce,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
    });
    profile = { sub: result.sub, email: result.email, name: result.name };
  } catch (err) {
    console.error('[coinpay] sign-in failed:', err?.message ?? err);
    return seeOther(linking ? '/account?coinpay=failed#coinpay' : '/login?error=coinpay-failed');
  }

  const outcome = await signInWithCoinpay(db(), profile, { linkUserId: pending.linkUserId });
  if (!outcome.ok) {
    return seeOther(linking ? `/account?coinpay=${outcome.error}#coinpay` : `/login?error=coinpay-${outcome.error}`);
  }
  if (linking) return seeOther('/account?coinpay=connected#coinpay');

  const meta = await requestMeta();
  const { token } = await startSession(db(), outcome.userId, meta);
  await setSessionCookie(token);

  if (outcome.created) return seeOther('/account?welcome=coinpay#coinpay');
  return seeOther(pending.next);
}

