import { finishRegistration } from '@rssamplifier/auth';

import { db, siteUrl } from '../../../../../lib/db.js';
import { currentUser } from '../../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Verify and store a newly created passkey.
 *
 * @param {Request} req
 * @returns {Promise<Response>}
 */
export async function POST(req) {
  const user = await currentUser();
  if (!user) return json({ error: 'sign-in-required' }, 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  const result = await finishRegistration(db(), {
    userId: String(user.id),
    challengeId: String(body?.challengeId ?? ''),
    response: body?.response,
    name: body?.name ?? null,
    siteUrl: siteUrl(),
  });

  if (!result.ok) return json({ error: result.error }, 400);
  return json({ ok: true, credentialId: result.credentialId });
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
