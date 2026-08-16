import { beginLogin } from '@rssamplifier/auth';

import { db, siteUrl } from '../../../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Options for signing in with a passkey.
 *
 * Open to anyone, and deliberately says nothing about who exists: the
 * credential list is empty, so the authenticator offers whatever it holds for
 * this site and the reader never types an address.
 *
 * @returns {Promise<Response>}
 */
export async function POST() {
  const { options, challengeId } = await beginLogin(db(), siteUrl());
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
