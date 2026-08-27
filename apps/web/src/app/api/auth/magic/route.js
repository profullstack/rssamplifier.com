import { requestSignInLink } from '@rssamplifier/auth';

import { db, siteUrl } from '../../../../lib/db.js';
import { magicReturnPath } from '../../../../lib/signInForm.js';
import { attempt, callerAddress } from '../../../../lib/authThrottle.js';

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
  // Metered before the body is even read. `requestSignInLink` already caps
  // links at five per *address* per hour, which does nothing about one caller
  // asking for links to ten thousand different addresses — that is somebody
  // else's inbox being used as a weapon and our mail bill paying for it.
  //
  // Unlike the per-address cap below, a refusal here is reported honestly
  // rather than as success. The anti-enumeration argument does not apply: this
  // says something about the caller, not about whether any address is
  // registered, so it leaks nothing a caller did not already know.
  const caller = callerAddress(req);
  const verdict = attempt(`magic-request:${caller}`);
  if (!verdict.ok) return tooMany(req, verdict.retryAfter);

  const contentType = req.headers.get('content-type') ?? '';
  let email = '';
  // Which page the form was on, so a reader who asked to *create* an account is
  // not answered by a page headed "Sign in". Anything unrecognised falls back
  // to /login rather than being reflected into the Location header.
  let from = '/login';

  try {
    if (contentType.includes('application/json')) {
      email = String((await req.json())?.email ?? '');
    } else {
      const form = await req.formData();
      email = String(form.get('email') ?? '');
      from = magicReturnPath(form.get('from'));
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
    return new Response(null, { status: 303, headers: { location: `${from}?${status}` } });
  }

  if (hardFailure) return json({ ok: false, error: result.error }, 400);
  return json({ ok: true, message: 'If that address can receive mail, a link is on its way.' });
}

/**
 * Refuse an over-eager caller, in whichever dialect it asked.
 *
 * An HTML caller is sent back to the form it posted from rather than shown a
 * bare 429 page, because the one person who will ever see this legitimately is
 * a reader who pressed the button too many times and needs to be told to wait,
 * not handed a status code.
 *
 * @param {Request} req
 * @param {number} retryAfter seconds
 * @returns {Response}
 */
function tooMany(req, retryAfter) {
  const headers = { 'retry-after': String(retryAfter) };

  if ((req.headers.get('accept') ?? '').includes('text/html')) {
    return new Response(null, {
      status: 303,
      headers: { ...headers, location: `/login?error=too-many&retry=${retryAfter}` },
    });
  }

  return new Response(
    JSON.stringify({ ok: false, error: 'too-many-requests', retryAfter }, null, 2),
    {
      status: 429,
      headers: {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
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
