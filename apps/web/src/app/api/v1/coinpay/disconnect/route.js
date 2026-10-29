import { disconnectCoinpay } from '@rssamplifier/auth';

import { db } from '../../../../../lib/db.js';
import { currentUser } from '../../../../../lib/auth.js';
import { sameOrigin, seeOther } from '../../../../../lib/coinpay.js';

export const dynamic = 'force-dynamic';

/**
 * Disconnect CoinPay from the signed-in account: the account page's form.
 * Refused when CoinPay is the only way back in (no proven address, no passkey).
 *
 * @param {Request} req
 */
export async function POST(req) {
  if (!sameOrigin(req)) return new Response('Bad origin', { status: 403 });
  const user = await currentUser();
  if (!user) return seeOther('/login?next=%2Faccount');

  const result = await disconnectCoinpay(db(), String(user.id));
  return seeOther(`/account?coinpay=${result.ok ? 'disconnected' : result.error}#coinpay`);
}
