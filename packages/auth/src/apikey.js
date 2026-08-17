import { randomBytes } from 'node:crypto';

import { hashToken } from './tokens.js';

/**
 * Keys for the programmatic surface.
 *
 * Same rule as every other secret here: the database holds a hash, the caller
 * holds the only copy of the token. What differs is that an API key is pasted
 * into somebody's config file and lives for months, so it needs two things a
 * session cookie does not — a visible prefix, so its owner can tell two keys
 * apart in a list, and a shape that is obviously a credential when it turns up
 * in a log or a public repository.
 */

/** Marks the string as ours, and as a secret, on sight. */
const PREFIX = 'rsa';

/** Bytes of randomness in the secret half. */
const SECRET_BYTES = 24;

/**
 * Mint a key.
 *
 * The token is `rsa_<public>_<secret>`. The public half is stored alongside the
 * hash and shown in listings; the secret half is never stored at all.
 *
 * @returns {{ token: string, prefix: string, hash: string }}
 */
export function newApiKey() {
  const publicPart = randomBytes(4).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${PREFIX}_${publicPart}_${secret}`;

  return { token, prefix: `${PREFIX}_${publicPart}`, hash: hashToken(token) };
}

/**
 * Pull a key out of a request.
 *
 * Accepts `Authorization: Bearer <token>` — the form every HTTP client already
 * knows how to send — and an `X-API-Key` header for the ones that reserve
 * Authorization for something else. A key is never read from the query string:
 * URLs end up in access logs, browser history and referrer headers, and a
 * credential that leaks by being written down is the most common way they leak.
 *
 * @param {Request} req
 * @returns {string|null}
 */
export function apiKeyFromRequest(req) {
  const auth = req.headers.get('authorization') ?? '';
  const bearer = /^bearer\s+(\S+)$/i.exec(auth.trim());
  if (bearer) return bearer[1];

  const header = req.headers.get('x-api-key');
  return header ? header.trim() : null;
}

/**
 * Is this string shaped like one of our keys?
 *
 * Lets a caller be told "that is not a key" without a database round trip, and
 * keeps a malformed header out of the lookup path entirely.
 *
 * @param {string|null|undefined} token
 * @returns {boolean}
 */
export function looksLikeApiKey(token) {
  return typeof token === 'string' && new RegExp(`^${PREFIX}_[0-9a-f]{8}_[\\w-]{20,}$`).test(token);
}

export { hashToken };
