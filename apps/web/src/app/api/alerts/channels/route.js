import { alerts } from '@rssamplifier/db';
import { checkWebhookUrl } from '@rssamplifier/notify';

import { db } from '../../../../lib/db.js';
import { currentUser } from '../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/** Where every answer from this endpoint sends a browser back to. */
const PAGE = '/account/alerts';

/**
 * Where an account's alerts go.
 *
 * Plain form posts, like every other write on the site, because this is a
 * settings page rather than anything that needs to feel instant. The browser
 * push channel is the exception and has its own endpoint: it is created from a
 * subscription object the browser mints, which no form can carry.
 *
 * One rule shapes the whole file: **email goes to the account's own address and
 * nowhere else.** An "add an address" field would make this endpoint a way to
 * point somebody else's inbox at a firehose they never asked for, and the
 * verification round trip that would fix it is a whole flow to build for a
 * feature nobody has asked for. The address is already verified — it is how the
 * account signs in.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  if (!user) return redirect(`/login?next=${encodeURIComponent(PAGE)}`);

  let form;
  try {
    form = await req.formData();
  } catch {
    return redirect(`${PAGE}?error=bad-request`);
  }

  const action = String(form.get('action') ?? '');
  const client = db();
  const userId = String(user.id);

  if (action === 'email') return addEmail(client, userId, String(user.email ?? ''));
  if (action === 'webhook') return addWebhook(client, userId, form);
  if (action === 'enable' || action === 'disable') {
    const ok = await alerts.setChannelEnabled(client, String(form.get('id') ?? ''), userId, action === 'enable');
    return redirect(ok ? PAGE : `${PAGE}?error=unknown-channel`);
  }
  if (action === 'remove') {
    const ok = await alerts.deleteChannel(client, String(form.get('id') ?? ''), userId);
    return redirect(ok ? `${PAGE}?removed=1` : `${PAGE}?error=unknown-channel`);
  }

  return redirect(`${PAGE}?error=bad-request`);
}

/**
 * Switch on email alerts to the address this account signs in with.
 *
 * @param {import('@libsql/client').Client} client
 * @param {string} userId
 * @param {string} email
 * @returns {Promise<Response>}
 */
async function addEmail(client, userId, email) {
  if (!email) return redirect(`${PAGE}?error=no-address`);
  if (!(await room(client, userId))) return redirect(`${PAGE}?error=too-many`);

  await alerts.addChannel(client, { userId, kind: 'email', target: email, label: 'Email' });
  return redirect(`${PAGE}?added=email`);
}

/**
 * Point a webhook at this account's alerts.
 *
 * @param {import('@libsql/client').Client} client
 * @param {string} userId
 * @param {FormData} form
 * @returns {Promise<Response>}
 */
async function addWebhook(client, userId, form) {
  const checked = checkWebhookUrl(String(form.get('url') ?? ''));
  if (!checked.ok) return redirect(`${PAGE}?error=${encodeURIComponent(checked.error)}`);
  if (!(await room(client, userId))) return redirect(`${PAGE}?error=too-many`);

  const secret = String(form.get('secret') ?? '').trim();

  await alerts.addChannel(client, {
    userId,
    kind: 'webhook',
    target: checked.url,
    // Stored only when there is one. A receiver that does not check signatures
    // should not be handed a secret it will never use.
    secret: secret ? { secret: secret.slice(0, 200) } : null,
    label: String(form.get('label') ?? '').slice(0, 60),
  });

  return redirect(`${PAGE}?added=webhook`);
}

/**
 * Whether this account may add another channel.
 *
 * Checked before the insert rather than enforced by the schema, because adding
 * a channel that already exists is an update and must not count against the
 * ceiling — a browser re-subscribing on its eleventh attempt is still one phone.
 *
 * @param {import('@libsql/client').Client} client
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function room(client, userId) {
  return (await alerts.channelCount(client, userId)) < alerts.MAX_CHANNELS_PER_USER;
}

/**
 * @param {string} location
 * @returns {Response}
 */
function redirect(location) {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}
