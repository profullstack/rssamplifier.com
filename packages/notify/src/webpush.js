import {
  generateVapidKeys as mintVapidKeys,
  parseSubscription,
  sendPush as deliverPush,
  vapidKeysFromEnv,
} from '@profullstack/notifications/server';

/**
 * Web Push, by way of `@profullstack/notifications`.
 *
 * This used to be two hundred lines of RFC 8188/8291/8292 written out by hand.
 * The same primitives now live in a shared, zero-dependency package that every
 * Profullstack app sends through, so a fix to one is a fix to all of them. What
 * stays here is the part that is this app's own: which environment variables
 * hold the keys, the contact address, how long a push service should hold an
 * alert, and the `{ ok, error, gone }` outcome shape the sender records against
 * each channel.
 *
 * Keys are in the same base64url format as before (and as the `web-push`
 * package's), so every subscription already in the database keeps working.
 *
 * Nothing here throws for an ordinary failure. A push service returning 410 for
 * a browser that no longer exists is the normal end of a subscription's life,
 * not an exception, and the caller deletes the row.
 */

/** How long a push service should hold an undelivered alert. Four hours. */
const DEFAULT_TTL = 14_400;

/**
 * Mint a VAPID key pair.
 *
 * Called by `pnpm vapid` rather than at runtime: the pair is an identity, and
 * regenerating it on boot would invalidate every subscription in the database
 * the first time the service restarted.
 *
 * @returns {{ publicKey: string, privateKey: string }}
 */
export function generateVapidKeys() {
  return mintVapidKeys();
}

/**
 * Read the VAPID configuration out of the environment, or null if absent.
 *
 * Absent is an ordinary state — a deployment with no push keys serves the site
 * perfectly well and simply never offers browser alerts — so this reports it
 * rather than throwing, the way `emailEnabled()` does for mail.
 *
 * Read at run time, on every call: a key compiled into a bundle at build time is
 * how push silently breaks in production.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ publicKey: string, privateKey: string, subject: string }|null}
 */
export function vapidConfig(env = process.env) {
  const keys = vapidKeysFromEnv(env);
  if (!keys) return null;

  return {
    ...keys,
    // A contact address, so a push service with a problem has somewhere to
    // complain to. Required by RFC 8292; the default is the site's own.
    subject: env['VAPID_SUBJECT'] || 'mailto:hello@rssamplifier.com',
  };
}

/**
 * Deliver one alert to one browser.
 *
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {string} payload JSON the service worker will read
 * @param {{ publicKey: string, privateKey: string, subject: string }} vapid
 * @param {{ ttl?: number, urgency?: 'very-low'|'low'|'normal'|'high', fetch?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, gone?: boolean }>}
 */
export async function sendPush(subscription, payload, vapid, opts = {}) {
  // A subscription whose keys will not parse can never be encrypted to, so it
  // is retired rather than retried.
  const parsed = parseSubscription(subscription);
  if (!parsed) return { ok: false, error: 'incomplete-subscription', gone: true };

  const result = await deliverPush(parsed, payload, {
    keys: { publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    subject: vapid.subject,
    ttl: opts.ttl ?? DEFAULT_TTL,
    // The default urgency wakes a phone. An alert about a blog post is worth
    // reading, not worth waking up for.
    urgency: opts.urgency ?? 'normal',
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  if (result.sent) return { ok: true };

  // 404 and 410 are the push services' way of saying the browser is gone —
  // uninstalled, site data cleared, permission revoked. There is nothing to
  // retry and the row should stop being tried.
  const error = result.status ? `push-${result.status}` : String(result.error ?? 'push-failed');
  return { ok: false, gone: result.gone, error };
}
