import { beginRegistration } from '@rssamplifier/auth';

import { db, siteUrl } from '../../../../../lib/db.js';
import { currentUser } from '../../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Options for adding a passkey to the signed-in account.
 *
 * Registration requires a session: a passkey is added to an account that has
 * already been proven, never used to claim one.
 *
 * @returns {Promise<Response>}
 */
export async function POST() {
  const user = await currentUser();
  if (!user) return json({ error: 'sign-in-required' }, 401);

  const { options, challengeId } = await beginRegistration(
    db(),
    { id: String(user.id), email: String(user.email) },
    siteUrl(),
  );

  return json({ options, challengeId });
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
