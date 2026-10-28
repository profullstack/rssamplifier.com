import { createHooks, webhooksApi } from '@rssamplifier/notify';

import { db } from './db.js';
import { callerOf } from './profileAuth.js';

/**
 * Webhooks on the web side: the API, the settings page, the MCP tools.
 *
 * The hub is the same one the poller runs (packages/notify/src/hooks.js), on
 * the same tables. It is never started here: the poller is the one process
 * that drains deliveries, so a web worker only creates, lists, tests and
 * rotates. `test()` sends its ping directly, which is why it works from here.
 *
 * Built on first use rather than at import, so `next build` never opens the
 * database pool.
 */

/** @type {import('@profullstack/webhooks').Webhooks | null} */
let hub = null;

/** @returns {import('@profullstack/webhooks').Webhooks} */
export function hooks() {
  hub ??= createHooks(db());
  return hub;
}

/**
 * The account a webhooks request acts for: the session, or one of the
 * account's API keys (`Authorization: Bearer rsa_...`). An
 * OpenAccess grant names a principal at the hub, not an account here, so it
 * owns no webhooks.
 *
 * @param {Request} req
 * @param {Parameters<typeof callerOf>[1]} [deps]
 * @returns {Promise<string|null>}
 */
export async function webhookOwner(req, deps) {
  const caller = await callerOf(req, deps);
  if (caller.kind !== 'session' && caller.kind !== 'apikey') return null;
  return caller.userId;
}

/** Where the API is mounted. */
export const WEBHOOKS_BASE = '/api/v1/webhooks';

/**
 * A /api/v1/webhooks fetch handler (null for a path outside it).
 *
 * @param {Parameters<typeof callerOf>[1]} [deps] for tests: who the session is
 * @returns {(req: Request) => Promise<Response|null>}
 */
export function makeWebhooksHandler(deps) {
  return webhooksApi(hooks(), { basePath: WEBHOOKS_BASE, owner: (r) => webhookOwner(r, deps) });
}

/** @type {((req: Request) => Promise<Response|null>) | null} */
let handler = null;

/**
 * The /api/v1/webhooks handler the route uses.
 *
 * @param {Request} req
 * @returns {Promise<Response|null>}
 */
export function webhooksHandler(req) {
  handler ??= makeWebhooksHandler();
  return handler(req);
}
