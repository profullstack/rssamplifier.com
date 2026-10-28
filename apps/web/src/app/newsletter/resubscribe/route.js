import { newsletter } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * The Re-subscribe button on /newsletter/manage. A POST of the same account
 * and token the unsubscribe link carried; puts the account back on the list.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const form = await req.formData().catch(() => null);
  const u = String(form?.get('u') ?? '').slice(0, 80);
  const t = String(form?.get('t') ?? '').slice(0, 80);
  const user = await newsletter.userForToken(db(), u, t);
  if (user) await newsletter.setSubscribed(db(), user.id, true);
  const q = new URLSearchParams({ u, t, done: user ? 'on' : 'bad' });
  return new Response(null, { status: 303, headers: { location: `/newsletter/manage?${q}`, 'cache-control': 'no-store' } });
}
