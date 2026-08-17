import { alerts } from '@rssamplifier/db';
import { vapidConfig } from '@rssamplifier/notify';

import { db } from '../../../../lib/db.js';
import { currentUser } from '../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Browser push subscriptions.
 *
 * The one channel that cannot be a form post. A push subscription is minted by
 * the browser — an endpoint on somebody else's push service plus the two keys
 * that let us encrypt to it — and only JavaScript can ask for it.
 *
 * GET hands out the public half of the VAPID pair, which the subscribe call
 * needs and which is not a secret: every browser that subscribes is given it.
 * It also answers whether push is configured at all, so the page can say "not
 * available here" instead of offering a button that cannot work.
 */

/**
 * @returns {Promise<Response>}
 */
export async function GET() {
  const vapid = vapidConfig();
  return json({ enabled: Boolean(vapid), key: vapid?.publicKey ?? null });
}

/**
 * Record or forget one browser.
 *
 * @param {Request} req
 * @returns {Promise<Response>}
 */
export async function POST(req) {
  const user = await currentUser();
  if (!user) return json({ error: 'sign-in-required' }, 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  const client = db();
  const userId = String(user.id);
  const endpoint = String(body?.endpoint ?? '');

  if (String(body?.action ?? '') === 'unsubscribe') {
    // Reported as done either way. A browser that has already been forgotten —
    // by a `pushsubscriptionchange`, or by the sender retiring a dead endpoint —
    // is in exactly the state the caller asked for.
    await alerts.deletePushChannel(client, userId, endpoint);
    return json({ ok: true, subscribed: false });
  }

  const p256dh = String(body?.keys?.p256dh ?? '');
  const auth = String(body?.keys?.auth ?? '');

  // All three or none. A row missing either key can never be encrypted to, and
  // storing one would be storing a channel that fails on every send until it
  // retires itself.
  if (!endpoint || !p256dh || !auth) return json({ error: 'incomplete-subscription' }, 400);
  if (!endpoint.startsWith('https://')) return json({ error: 'bad-endpoint' }, 400);

  if ((await alerts.channelCount(client, userId)) >= alerts.MAX_CHANNELS_PER_USER) {
    // Only reached by an account genuinely at the ceiling: re-subscribing from a
    // browser already recorded is an update, and addChannel handles it without
    // adding a row — but it is counted here first, so the check has to come
    // after the cheap ones and be forgiving about what it means.
    const existing = await alerts.channelsForUser(client, userId);
    const known = existing.some((row) => row.kind === 'web' && String(row.target) === endpoint);
    if (!known) return json({ error: 'too-many-channels' }, 409);
  }

  await alerts.addChannel(client, {
    userId,
    kind: 'web',
    target: endpoint,
    secret: { p256dh, auth },
    label: String(body?.label ?? 'This browser').slice(0, 60),
  });

  return json({ ok: true, subscribed: true });
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
