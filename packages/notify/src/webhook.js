import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook delivery.
 *
 * The third channel, and the one that exists because the other two are for
 * people. A reader who wants their own alerts in their own system — a Slack
 * relay, a home dashboard, a script that files them — should not have to scrape
 * an inbox to get them.
 *
 * One POST, one JSON body, one optional signature. Deliberately not a retry
 * queue: the sender already retries by leaving the watermark where it was, and a
 * receiver that is down for an hour is better served by the river at /following
 * than by an hour of queued duplicates arriving at once.
 */

/** How long one delivery may take before it is abandoned. */
const TIMEOUT_MS = 10_000;

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

/**
 * Deliver one alert batch to one webhook.
 *
 * @param {string} url
 * @param {unknown} payload
 * @param {{ secret?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, gone?: boolean }>}
 */
export async function postWebhook(url, payload, opts = {}) {
  const allowed = checkWebhookUrl(url);
  // A stored URL that no longer passes the check — the rules tightened, or the
  // row predates them — is retired rather than retried: it will never pass.
  if (!allowed.ok) return { ok: false, error: allowed.error, gone: true };

  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'rssamplifier-alerts/1.0 (+https://rssamplifier.com/alerts)',
  };
  if (opts.secret) headers[SIGNATURE_HEADER] = signBody(body, opts.secret);

  const control = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);

  try {
    const res = await fetch(allowed.url, { method: 'POST', headers, body, signal: control });

    if (res.ok) return { ok: true };

    // 410 is the one status a receiver can use to say "stop": it is the same
    // meaning a push service gives it, so the sender treats it the same way.
    return { ok: false, gone: res.status === 410, error: `webhook-${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
