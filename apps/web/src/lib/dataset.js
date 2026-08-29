import { dataset, apikeys } from '@rssamplifier/db';
import { apiKeyFromRequest, looksLikeApiKey, hashToken } from '@rssamplifier/auth';

import { db } from './db.js';
import { currentUser } from './auth.js';

/**
 * The gate on the corpus.
 *
 * The clock it is read by lives in ./datasetWindow.js, which is re-exported here
 * so a route needs one import rather than two — the split is about what can be
 * unit-tested, not about what a caller should have to know.
 */
export {
  windowStart,
  windowEnd,
  latestClosedWindow,
  resolveWindow,
  startOfUtcDay,
} from './datasetWindow.js';

/**
 * Who is asking for the corpus, and may they have it.
 *
 * Accepts a session or an API key, in that order, and that pairing is the point.
 * A person evaluating the offer clicks a link in a browser and must not have to
 * mint a credential to see whether the thing works; the pipeline that pulls it
 * every four hours for the next year must never depend on a cookie. Both resolve
 * to the same account and the same licence.
 *
 * The three refusals are deliberately distinguishable, because they need three
 * different actions and collapsing them into one 403 sends every one of them to
 * a human:
 *
 *   * 401 — nobody is signed in and no key was presented. Sign in.
 *   * 401 — a key was presented and is not a key we know. Fix the credential.
 *   * 402 — we know exactly who you are and you have no licence. Talk to us.
 *
 * The 402 is the only one that is a sales question, and it is the one that
 * carries a link to /sales.
 *
 * @param {Request} req
 * @returns {Promise<{ ok: true, user: object, grant: object, apiKeyId: string|null } | { ok: false, response: Response }>}
 */
export async function datasetCaller(req) {
  const client = db();
  const presented = apiKeyFromRequest(req);

  /** @type {object|null} */
  let user = null;
  /** @type {string|null} */
  let apiKeyId = null;

  if (presented) {
    if (!looksLikeApiKey(presented)) {
      return { ok: false, response: refuse(401, 'that is not a valid API key') };
    }

    const key = await apikeys.keyByHash(client, hashToken(presented));
    if (!key) return { ok: false, response: refuse(401, 'unknown or revoked API key') };

    apiKeyId = String(key.id);
    // The key identifies an account; the licence hangs off the account, not off
    // the key. So revoking one key does not cost a buyer their access, and a
    // buyer rotating keys does not have to tell us.
    user = { id: String(key.user_id) };
    apikeys.touchKey(client, apiKeyId, key.last_used_at).catch(() => {});
  } else {
    user = await currentUser();
    if (!user) {
      return {
        ok: false,
        response: refuse(
          401,
          'the corpus needs an account: sign in, or send an API key as a bearer token',
        ),
      };
    }
  }

  const grant = await dataset.activeGrant(client, String(user.id));
  if (!grant) {
    return {
      ok: false,
      response: Response.json(
        {
          error: 'no-dataset-licence',
          detail:
            'This account has no corpus licence. Everything in the open directory stays free — /api/feeds, /api/search, /opml and the MCP server all answer without one.',
          sales: 'https://rssamplifier.com/sales',
        },
        { status: 402, headers: { 'access-control-allow-origin': '*' } },
      ),
    };
  }

  return { ok: true, user, grant, apiKeyId };
}

/**
 * @param {number} status
 * @param {string} error
 * @returns {Response}
 */
function refuse(status, error) {
  return Response.json(
    { error, sales: 'https://rssamplifier.com/sales' },
    { status, headers: { 'access-control-allow-origin': '*' } },
  );
}
