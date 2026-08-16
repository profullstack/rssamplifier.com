import { finishLogin, startSession } from '@rssamplifier/auth';

import { db, siteUrl } from '../../../../../lib/db.js';
import { setSessionCookie, requestMeta } from '../../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Verify a passkey assertion and start a session.
 *
 * @param {Request} req
 * @returns {Promise<Response>}
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  const result = await finishLogin(db(), {
    challengeId: String(body?.challengeId ?? ''),
    response: body?.response,
    siteUrl: siteUrl(),
  });

  // One message for every way this can fail. Distinguishing "no such passkey"
  // from "bad signature" would say which credentials are registered here.
  if (!result.ok) return json({ error: 'sign-in-failed' }, 400);

  const meta = await requestMeta();
  const { token } = await startSession(db(), result.userId, meta);
  await setSessionCookie(token);

  return json({ ok: true, next: '/account' });
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
