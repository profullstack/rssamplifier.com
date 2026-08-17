import { apikeys } from '@rssamplifier/db';
import { apiKeyFromRequest, looksLikeApiKey, hashToken } from '@rssamplifier/auth';

import { db } from './db.js';
import { consume, limitHeaders, ANONYMOUS_HOURLY } from './ratelimit.js';

/**
 * Who is calling, and may they.
 *
 * The directory's API is open and stays open. This is not an authentication
 * gate — an anonymous caller is answered exactly as a keyed one is, from the
 * same data, with no field withheld. The only difference a key makes is how
 * many times an hour the caller may ask.
 *
 * That ordering matters for what gets built later. A metered-but-open API can
 * grow a paid tier by raising a number; a gated one has already broken every
 * agent that reads this directory today, and no later change puts them back.
 */

/**
 * The address a request came from, for counting anonymous callers.
 *
 * Railway terminates TLS in front of the app, so the socket address is a proxy
 * and the real client is in x-forwarded-for. Only the first entry is read: the
 * rest are supplied by whatever sat in between and a caller can write anything
 * they like into them.
 *
 * @param {Request} req
 * @returns {string}
 */
function callerAddress(req) {
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  return first || req.headers.get('x-real-ip') || 'unknown';
}

/**
 * Identify and meter one API request.
 *
 * A key that is presented but not recognised is refused outright rather than
 * quietly demoted to the anonymous allowance: somebody pasted a revoked or
 * mistyped credential into a config file, and telling them so is the only way
 * they will ever find out.
 *
 * @param {Request} req
 * @returns {Promise<{ ok: true, headers: Record<string,string>, keyId: string|null } | { ok: false, response: Response }>}
 */
export async function guard(req) {
  const presented = apiKeyFromRequest(req);

  if (presented) {
    if (!looksLikeApiKey(presented)) {
      return { ok: false, response: refuse(401, 'that is not a valid API key') };
    }

    const client = db();
    const key = await apikeys.keyByHash(client, hashToken(presented));
    if (!key) {
      return { ok: false, response: refuse(401, 'unknown or revoked API key') };
    }

    const limit = Number(key.hourly_limit) || 5000;
    const verdict = consume(`key:${key.id}`, limit);

    // Fire-and-forget, and only about once an hour per key. The caller is
    // waiting on their data, not on our bookkeeping.
    apikeys.touchKey(client, String(key.id), key.last_used_at).catch(() => {});

    if (!verdict.ok) return { ok: false, response: tooMany(verdict) };
    return { ok: true, headers: limitHeaders(verdict), keyId: String(key.id) };
  }

  const verdict = consume(`ip:${callerAddress(req)}`, ANONYMOUS_HOURLY);
  if (!verdict.ok) return { ok: false, response: tooMany(verdict) };
  return { ok: true, headers: limitHeaders(verdict), keyId: null };
}

/**
 * @param {number} status
 * @param {string} error
 * @returns {Response}
 */
function refuse(status, error) {
  return Response.json(
    { error, docs: 'https://rssamplifier.com/about' },
    { status, headers: { 'access-control-allow-origin': '*' } },
  );
}

/**
 * @param {{ limit: number, remaining: number, resetAt: number, retryAfter: number }} verdict
 * @returns {Response}
 */
function tooMany(verdict) {
  return Response.json(
    {
      error: 'rate limit exceeded',
      limit: verdict.limit,
      // Said plainly, because the alternative is that they guess and retry.
      hint: 'Create a free API key for a higher limit: https://rssamplifier.com/account',
      retryAfter: verdict.retryAfter,
    },
    {
      status: 429,
      headers: {
        ...limitHeaders(verdict),
        'retry-after': String(verdict.retryAfter),
        'access-control-allow-origin': '*',
      },
    },
  );
}
