import { accounts } from '@rssamplifier/db';

import { db } from '../../../../../lib/db.js';
import { currentUser } from '../../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Remove a passkey from the signed-in account.
 *
 * The delete is scoped to the account as well as the credential id, so knowing
 * someone else's credential id is not enough to revoke it.
 *
 * Removing the last passkey is allowed: the emailed link always works, so an
 * account can never be locked out by this, and refusing would strand anyone
 * whose only key is on a device they no longer have.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  if (!user) {
    return wantsHtml
      ? new Response(null, { status: 303, headers: { location: '/login' } })
      : json({ error: 'sign-in-required' }, 401);
  }

  let id = '';
  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      id = String((await req.json())?.id ?? '');
    } else {
      id = String((await req.formData()).get('id') ?? '');
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  const removed = await accounts.deleteCredential(db(), id, String(user.id));

  if (wantsHtml) {
    return new Response(null, {
      status: 303,
      headers: { location: removed ? '/account?revoked=1' : '/account' },
    });
  }

  return json({ ok: removed });
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
