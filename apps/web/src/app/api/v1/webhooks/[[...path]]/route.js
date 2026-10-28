import { webhooksHandler } from '../../../../../lib/webhooks.js';

export const dynamic = 'force-dynamic';

/**
 * /api/v1/webhooks: the fleet's webhooks API (@profullstack/webhooks).
 *
 *   GET    /api/v1/webhooks                      endpoints + event_types
 *   POST   /api/v1/webhooks                      { url, events?, description? } -> { endpoint, secret }
 *   GET    /api/v1/webhooks/:id                  one endpoint
 *   PATCH  /api/v1/webhooks/:id                  { url?, events?, description?, enabled? }
 *   DELETE /api/v1/webhooks/:id
 *   GET    /api/v1/webhooks/:id/secret           { secret }
 *   POST   /api/v1/webhooks/:id/rotate           { secret } (the old one stops at once)
 *   POST   /api/v1/webhooks/:id/test             sends webhook.test now
 *   GET    /api/v1/webhooks/:id/deliveries       its delivery log
 *   GET    /api/v1/webhooks/deliveries           every endpoint's log
 *   POST   /api/v1/webhooks/deliveries/:id/retry send one again
 *
 * The account is the session or an API key (`Authorization: Bearer rsa_...`);
 * anything else is a 401. The one event is `posts.published`: a batch of new
 * posts from what the account has 🔔 on, the same batch email and push get.
 *
 * @param {Request} req
 */
async function handle(req) {
  const res = (await webhooksHandler(req)) ?? Response.json({ error: 'not found' }, { status: 404 });
  // Secrets travel in some of these bodies; nothing in between should keep one.
  res.headers.set('cache-control', 'no-store');
  return res;
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
