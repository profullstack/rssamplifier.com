import { apikeys } from '@rssamplifier/db';
import { newApiKey } from '@rssamplifier/auth';

import { db } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * The reader's own API keys.
 *
 * Session-authenticated, not key-authenticated: a key cannot mint another key,
 * so a leaked one cannot be used to grow itself a replacement that survives the
 * revocation of the original.
 *
 * Form-first, like everything else here — the account page posts an ordinary
 * form and gets redirected back — with JSON for callers that ask for it.
 */

/**
 * List this account's keys. Never returns a token: they are unrecoverable by
 * construction, and the listing exists to identify keys, not to re-read them.
 *
 * @returns {Promise<Response>}
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return json({ error: 'sign-in-required' }, 401);

  const rows = await apikeys.keysForUser(db(), String(user.id));

  return json({
    keys: rows.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      hourlyLimit: k.hourly_limit,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revokedAt: k.revoked_at,
    })),
  });
}

/**
 * Mint a key, or revoke one.
 *
 * Both live on POST because the account page reaches them through a plain HTML
 * form, which can only ever send GET or POST. `action=revoke` with an id is the
 * second verb.
 *
 * @param {Request} req
 * @returns {Promise<Response>}
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  if (!user) {
    return wantsHtml ? redirect('/login?next=/account') : json({ error: 'sign-in-required' }, 401);
  }

  const body = await readBody(req);
  if (!body) return json({ error: 'bad-request' }, 400);

  const client = db();

  if (body.action === 'revoke') {
    const revoked = await apikeys.revokeKey(client, String(body.id ?? ''), String(user.id));
    // Not `?revoked=`: the account page already spends that one on passkeys,
    // and reusing it would tell somebody who deleted a key that they deleted a
    // passkey.
    if (wantsHtml) {
      return redirect(revoked ? '/account?keyRevoked=1' : '/account?keyError=unknown-key');
    }
    return json({ revoked });
  }

  const live = await apikeys.liveKeyCount(client, String(user.id));
  if (live >= apikeys.MAX_KEYS_PER_USER) {
    if (wantsHtml) return redirect('/account?keyError=too-many-keys');
    return json({ error: 'too-many-keys', limit: apikeys.MAX_KEYS_PER_USER }, 409);
  }

  const minted = newApiKey();
  await apikeys.insertKey(client, {
    userId: String(user.id),
    name: String(body.name ?? '').slice(0, 60) || 'api key',
    prefix: minted.prefix,
    hash: minted.hash,
  });

  // The one and only time the token exists outside the caller's own machine.
  // Passed back through the URL for the HTML path so the account page can show
  // it once; it is not stored, and reloading the page loses it for good.
  if (wantsHtml) return redirect(`/account?created=${encodeURIComponent(minted.token)}`);
  return json({ token: minted.token, prefix: minted.prefix }, 201);
}

/**
 * Read a form or JSON body into the same shape.
 *
 * @param {Request} req
 * @returns {Promise<{ action?: string, id?: string, name?: string }|null>}
 */
async function readBody(req) {
  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const parsed = await req.json();
      return {
        action: String(parsed?.action ?? 'create'),
        id: parsed?.id == null ? undefined : String(parsed.id),
        name: parsed?.name == null ? undefined : String(parsed.name),
      };
    }

    const form = await req.formData();
    return {
      action: String(form.get('action') ?? 'create'),
      id: form.get('id') == null ? undefined : String(form.get('id')),
      name: form.get('name') == null ? undefined : String(form.get('name')),
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} to
 * @returns {Response}
 */
function redirect(to) {
  return new Response(null, { status: 303, headers: { location: to } });
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
