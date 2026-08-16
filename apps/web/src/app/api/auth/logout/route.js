import { endSession } from '@rssamplifier/auth';

import { db } from '../../../../lib/db.js';
import { sessionToken, clearSessionCookie } from '../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Sign out of this device.
 *
 * Only the presented session is dropped. Signing out of a laptop should not
 * sign out the phone, and someone who wants every session gone can revoke the
 * passkey instead.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const token = await sessionToken();
  await endSession(db(), token);
  await clearSessionCookie();

  if ((req.headers.get('accept') ?? '').includes('text/html')) {
    return new Response(null, { status: 303, headers: { location: '/' } });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
