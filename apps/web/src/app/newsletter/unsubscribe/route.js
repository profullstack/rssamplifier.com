import { newsletter } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * The unsubscribe link in every digest: `?u=<account>&t=<token>`.
 *
 *   GET   the click: takes the account off the list and shows the page that
 *         says so, with a button to come back (the house pattern: one click,
 *         a page that says you are done, one click to rejoin).
 *   POST  RFC 8058 one-click, sent by the mailbox itself
 *         (List-Unsubscribe-Post): off the list, 200, no page.
 *   HEAD  records nothing; link checkers and previewers stop here.
 *
 * A bad or stale link changes nothing and says so.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const { u, t } = params(req);
  const user = await newsletter.userForToken(db(), u, t);
  if (user) await newsletter.setSubscribed(db(), user.id, false);
  const q = new URLSearchParams({ u, t, done: user ? 'off' : 'bad' });
  return new Response(null, { status: 303, headers: { location: `/newsletter/manage?${q}`, 'cache-control': 'no-store' } });
}

/** @param {Request} req */
export async function POST(req) {
  const { u, t } = params(req);
  const user = await newsletter.userForToken(db(), u, t);
  if (!user) return new Response('unknown link\n', { status: 404, headers: { 'cache-control': 'no-store' } });
  await newsletter.setSubscribed(db(), user.id, false);
  // The button on /newsletter/manage posts here too; a browser gets the page.
  if ((req.headers.get('accept') ?? '').includes('text/html')) {
    const q = new URLSearchParams({ u, t, done: 'off' });
    return new Response(null, { status: 303, headers: { location: `/newsletter/manage?${q}`, 'cache-control': 'no-store' } });
  }
  return new Response('unsubscribed\n', { status: 200, headers: { 'cache-control': 'no-store' } });
}

export function HEAD() {
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}

/** @param {Request} req */
function params(req) {
  const url = new URL(req.url);
  return { u: String(url.searchParams.get('u') ?? '').slice(0, 80), t: String(url.searchParams.get('t') ?? '').slice(0, 80) };
}
