import { accounts } from '@rssamplifier/db';
import { newToken } from '@rssamplifier/auth';

import { db } from '../../../../lib/db.js';
import { currentUser } from '../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Mint or rotate the token in an account's personal feed URL.
 *
 * Minting is opt-in rather than automatic: an account that never subscribes to
 * its own river never needs a capability URL to exist, and a credential nobody
 * asked for is one more thing that can leak.
 *
 * `create` is idempotent — a second press hands back the URL already in use
 * rather than quietly breaking the reader it was pasted into. Rotating is the
 * destructive one, and it is a separate action for that reason.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  if (!user) {
    if (wantsHtml) return redirect('/login?next=%2Ffollowing');
    return json({ error: 'sign-in-required' }, 401);
  }

  let action = 'create';

  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      action = String((await req.json())?.action ?? 'create');
    } else {
      action = String((await req.formData()).get('action') ?? 'create');
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  const client = db();
  const userId = String(user.id);
  const existing = await accounts.feedToken(client, userId);

  const rotate = action === 'rotate';
  const token = !rotate && existing ? existing : newToken();

  if (token !== existing) await accounts.setFeedToken(client, userId, token);

  if (wantsHtml) return redirect(`/following${rotate ? '?rotated=1' : ''}`);
  return json({ ok: true, token, rotated: rotate });
}

/**
 * @param {string} location
 * @returns {Response}
 */
function redirect(location) {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    // A response carrying a live credential must not be stored by anything in
    // between.
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
