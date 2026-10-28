import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The pre-hub webhook signature, kept as the reference for receivers.
 *
 * Sending moved to @profullstack/webhooks (see ./hooks.js) on 2026-10-28. The
 * hub still sends `x-rssamplifier-signature` next to the Standard Webhooks
 * headers, computed exactly as `signBody` below, so a receiver written against
 * these functions keeps working. They stay here as that receiver's reference
 * and as what the tests verify a hub delivery against.
 */

/** The header the signature travels in, when there is one. */
export const SIGNATURE_HEADER = 'x-rssamplifier-signature';

/**
 * Sign a body, the way every webhook receiver expects to verify one.
 *
 * `sha256=` prefixed, so a receiver can tell which algorithm it is looking at
 * without being told out of band — and so a later algorithm is a new prefix
 * rather than a silent change of meaning.
 *
 * @param {string} body
 * @param {string} secret
 * @returns {string}
 */
export function signBody(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Whether a signature is the one this body and secret produce.
 *
 * Exported for the receiving side — the test uses it, and anyone writing a
 * receiver can read it as the reference. Compared in constant time, because a
 * byte-at-a-time comparison of an HMAC is a byte-at-a-time oracle for it.
 *
 * @param {string} body
 * @param {string} secret
 * @param {string} signature
 * @returns {boolean}
 */
export function verifySignature(body, secret, signature) {
  const expected = Buffer.from(signBody(body, secret));
  const given = Buffer.from(String(signature ?? ''));
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/**
 * Whether a URL is somewhere a webhook may be sent.
 *
 * The check that matters, and it is not about tidiness. This endpoint takes a
 * URL from a signed-in stranger and has a server make a request to it, which is
 * a server-side request forgery primitive unless something refuses the addresses
 * that only mean something from inside the network. https only, and no host that
 * resolves to somewhere private by name.
 *
 * Names rather than resolved addresses, which is the honest limitation: a
 * hostname that resolves to 127.0.0.1 gets through. Closing that properly means
 * resolving first and pinning the connection to the address that was checked,
 * which `fetch` cannot express — so what this buys is the accidental case and
 * the lazy case, not a determined one. The deployment's own egress rules are
 * where the rest of that belongs.
 *
 * @param {string} raw
 * @returns {{ ok: true, url: string }|{ ok: false, error: string }}
 */
export function checkWebhookUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, error: 'not-a-url' };
  }

  if (url.protocol !== 'https:') return { ok: false, error: 'https-required' };

  const host = url.hostname.toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (privateHost) return { ok: false, error: 'private-address' };

  return { ok: true, url: url.toString() };
}
