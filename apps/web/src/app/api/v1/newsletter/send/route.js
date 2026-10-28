import { runNewsletter } from '@rssamplifier/notify';

import { db } from '../../../../../lib/db.js';
import { adminEmails, callerOf } from '../../../../../lib/profileAuth.js';
import { noStoreJson } from '../../../../../lib/newsletterApi.js';

export const dynamic = 'force-dynamic';

/**
 * Run one pass of the weekly send, as the poller does. Admins only (session or
 * API key). `{ "dry_run": true }` is the default and writes nothing; a real
 * pass needs `{ "dry_run": false }` and still respects the week's slot unless
 * `"force": true`.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const caller = await callerOf(req);
  if (!caller.kind) return noStoreJson({ error: 'sign-in-required' }, 401);
  if (!caller.email || !adminEmails().includes(caller.email)) return noStoreJson({ error: 'admins-only' }, 403);

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dry_run !== false;
  const result = await runNewsletter(db(), { dryRun, force: body?.force === true });
  return noStoreJson(result);
}
