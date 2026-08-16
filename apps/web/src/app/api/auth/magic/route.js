import { requestSignInLink } from '@rssamplifier/auth';

import { db, siteUrl } from '../../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Ask for a sign-in link.
 *
 * Answers the same way whether or not the address has an account. The
 * alternative turns this into a way to enumerate who has registered, and the
 * reader is told to check their email either way, so there is nothing to gain
 * by being specific.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const contentType = req.headers.get('content-type') ?? '';
  let email = '';

  try {
    if (contentType.includes('application/json')) {
      email = String((await req.json())?.email ?? '');
    } else {
      email = String((await req.formData()).get('email') ?? '');
    }
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const result = await requestSignInLink(db(), email, siteUrl());

  // Only a misconfigured site or a malformed address is worth reporting back;
  // a rate limit is reported as success for the same reason as above.
  const hardFailure = result.error === 'invalid-email' || result.error === 'email-not-configured';

  if ((req.headers.get('accept') ?? '').includes('text/html')) {
    const status = hardFailure ? `error=${result.error}` : 'sent=1';
    return new Response(null, { status: 303, headers: { location: `/login?${status}` } });
  }

  if (hardFailure) return json({ ok: false, error: result.error }, 400);
  return json({ ok: true, message: 'If that address can receive mail, a link is on its way.' });
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
