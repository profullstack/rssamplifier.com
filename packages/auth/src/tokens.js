import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secrets that travel — session cookies and emailed sign-in links.
 *
 * The rule for both: the database stores a hash, never the value. A leaked
 * backup or a stray log line then yields nothing that can be presented back to
 * the server, which is the whole reason to hash something that is already
 * random rather than treating randomness as sufficient.
 */

/** 32 bytes of randomness — beyond any feasible guessing, and short enough for a URL. */
const TOKEN_BYTES = 32;

/**
 * A fresh secret, URL-safe.
 *
 * @returns {string}
 */
export function newToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The stored form of a secret.
 *
 * Plain SHA-256 with no salt or stretching, deliberately: the input is 256 bits
 * of entropy, so there is no dictionary to defend against and a slow hash would
 * only tax every request that checks a cookie.
 *
 * @param {string} token
 * @returns {string} hex digest
 */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Compare two hex digests without leaking where they diverge.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
