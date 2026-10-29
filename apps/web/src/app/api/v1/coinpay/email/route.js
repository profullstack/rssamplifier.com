import { requestEmailClaimLink } from '@rssamplifier/auth';

import { db, siteUrl } from '../../../../../lib/db.js';
import { currentUser } from '../../../../../lib/auth.js';
import { sameOrigin, seeOther } from '../../../../../lib/coinpay.js';
import { attempt, callerAddress } from '../../../../../lib/authThrottle.js';

export const dynamic = 'force-dynamic';

/**
 * A CoinPay-only account asks to use a real address. Nothing changes until the
 * link mailed to that address is followed (see consumeSignInLink).
 *
 * @param {Request} req
 */
export async function POST(req) {
  if (!sameOrigin(req)) return new Response('Bad origin', { status: 403 });
  const user = await currentUser();
  if (!user) return seeOther('/login?next=%2Faccount');

  const verdict = attempt(`coinpay-email:${callerAddress(req)}`);
  if (!verdict.ok) return seeOther('/account?coinpay=too-many#coinpay');

  const form = await req.formData().catch(() => null);
  const email = form?.get('email');
  const result = await requestEmailClaimLink(db(), String(user.id), typeof email === 'string' ? email : '', siteUrl());
  return seeOther(`/account?coinpay=${result.ok ? 'email-sent' : `email-${result.error}`}#coinpay`);
}
