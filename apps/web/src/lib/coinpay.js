import { siteUrl } from './db.js';

/**
 * Sign in with CoinPay: the deployment's client, and the cookie that pins a
 * login to the browser that started it.
 *
 * Read through a non-literal property access: Next inlines `process.env.FOO`
 * at build time, which would bake an absent value into the image for good.
 */

export const STATE_COOKIE = 'rssa_cp_state';
export const STATE_COOKIE_PATH = '/api/v1/coinpay/oauth';

/**
 * @returns {{ clientId: string, clientSecret: string, redirectUri: string } | null}
 */
export function coinpayConfig() {
  const env = process.env;
  const clientId = env['COINPAY_OAUTH_CLIENT_ID'] ?? '';
  const clientSecret = env['COINPAY_OAUTH_CLIENT_SECRET'] ?? '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: `${siteUrl()}/api/v1/coinpay/oauth/callback` };
}

/** Whether to offer the button at all. */
export function coinpayEnabled() {
  return coinpayConfig() !== null;
}

/**
 * @param {string} location a path on this site
 * @returns {Response}
 */
export function seeOther(location) {
  return new Response(null, {
    status: 303,
    headers: { location: `${siteUrl()}${location}`, 'cache-control': 'no-store' },
  });
}

/**
 * A form post from another site is refused. The session cookie is SameSite=Lax,
 * which already keeps it off a cross-site POST; this is the second lock.
 *
 * @param {Request} req
 * @returns {boolean}
 */
export function sameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(siteUrl()).host;
  } catch {
    return false;
  }
}
