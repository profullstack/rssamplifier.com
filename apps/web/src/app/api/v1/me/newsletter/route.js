import { newsletter } from '@rssamplifier/db';

import { db } from '../../../../../lib/db.js';
import { callerOf } from '../../../../../lib/profileAuth.js';
import { noStoreJson } from '../../../../../lib/newsletterApi.js';

export const dynamic = 'force-dynamic';

/**
 * Your own place on the weekly digest. The session or an API key
 * (`Authorization: Bearer rsa_...`).
 *
 *   GET  -> { subscribed }
 *   PUT  { "subscribed": false } -> { subscribed }
 *   POST the account page's form (subscribed=0|1), answered with a redirect
 *
 * @param {Request} req
 */
async function account(req) {
  const caller = await callerOf(req);
  return caller.userId && (caller.kind === 'session' || caller.kind === 'apikey') ? caller.userId : null;
}

/** @param {Request} req */
export async function GET(req) {
  const userId = await account(req);
  if (!userId) return noStoreJson({ error: 'sign-in-required' }, 401);
  return noStoreJson({ subscribed: Boolean(await newsletter.subscribed(db(), userId)) });
}

/** @param {Request} req */
export async function PUT(req) {
  const userId = await account(req);
  if (!userId) return noStoreJson({ error: 'sign-in-required' }, 401);
  const body = await req.json().catch(() => null);
  if (typeof body?.subscribed !== 'boolean') return noStoreJson({ error: 'subscribed must be true or false' }, 400);
  await newsletter.setSubscribed(db(), userId, body.subscribed);
  return noStoreJson({ subscribed: body.subscribed });
}

export const PATCH = PUT;

/** @param {Request} req */
export async function POST(req) {
  const userId = await account(req);
  if (!userId) return new Response(null, { status: 303, headers: { location: '/login' } });
  const form = await req.formData().catch(() => null);
  const on = String(form?.get('subscribed') ?? '') === '1';
  await newsletter.setSubscribed(db(), userId, on);
  return new Response(null, {
    status: 303,
    headers: { location: `/account?newsletter=${on ? 'on' : 'off'}#newsletter` },
  });
}
