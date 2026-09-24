import { vapidKeysFromEnv, vapidPublicKeyResponse } from '@profullstack/notifications/server';

/**
 * The VAPID public key, served at run time.
 *
 * Dynamic on purpose: Next inlines `process.env.*` at build time wherever it
 * can, and a key compiled into the build as undefined is how push silently
 * breaks in production — every browser told "not supported", every send
 * skipped. Read per request, the key is whatever the deployment has now.
 *
 * `{ publicKey }` with a 200 when push is configured, a 503 with
 * `publicKey: null` when it is not. The browser client in
 * `@profullstack/notifications/client` fetches this when it subscribes.
 */
export const dynamic = 'force-dynamic';

/**
 * @returns {Response}
 */
export function GET() {
  return vapidPublicKeyResponse(vapidKeysFromEnv(process.env));
}
