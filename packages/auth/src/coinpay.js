import { coinpay, accounts, nowIso } from '@rssamplifier/db';

import { hashToken, safeEqual } from './tokens.js';

/**
 * Sign in with CoinPay. CoinPay is the fleet's master account.
 *
 * The STANDING rule, which every function here exists to keep:
 *
 * - an account is bound to a CoinPay identity by its `sub`, never by email;
 * - a CoinPay login never lands in an existing account because the addresses
 *   match: CoinPay does not verify them (`email_verified` is always false), and
 *   an address here is something the reader proved by following a link;
 * - the CoinPay email is never written to users.email. A new CoinPay account
 *   gets a coinpay.invalid placeholder until it proves a real address;
 * - CoinPay is connected to an existing account only from inside it.
 *
 * The HTTP side (redirects, cookies, the token exchange) lives in the web app;
 * this is the part that decides, so it can be tested against a database.
 */

/** Ten minutes from the authorize redirect to the callback. */
export const PENDING_MS = 10 * 60 * 1000;

/**
 * Only a same-origin path is a place to go after signing in.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function safeNext(value) {
  if (typeof value !== 'string' || value.length === 0) return '/account';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/account';
  return value;
}

/**
 * @param {string} sub
 * @returns {string}
 */
function placeholderFor(sub) {
  return `coinpay-${hashToken(sub).slice(0, 20)}@${coinpay.PLACEHOLDER_DOMAIN}`;
}

/**
 * @param {unknown} email
 * @returns {string|null}
 */
function contactEmail(email) {
  const value = typeof email === 'string' ? email.trim() : '';
  return value && value.length <= 254 && value.includes('@') ? value : null;
}

/**
 * Remember an authorization request until its callback.
 *
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
 * @param {string} state
 * @param {{ verifier: string, nonce: string, next: string, linkUserId: string|null }} pending
 */
export async function savePending(db, state, pending) {
  await coinpay.insertPending(db, {
    id: hashToken(state),
    verifier: pending.verifier,
    nonce: pending.nonce,
    next: safeNext(pending.next),
    linkUserId: pending.linkUserId,
    expiresAt: nowIso(PENDING_MS),
  });
}

/**
 * Check a callback's state and spend its pending request.
 *
 * The state must match the cookie set in the browser that started the login
 * (so a link crafted elsewhere cannot finish in yours), and it is single use.
 * When the request was "Connect CoinPay", the session finishing it must be the
 * one that started it.
 *
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
 * @param {{ state: string|null|undefined, cookieState: string|null|undefined, sessionUserId: string|null }} input
 * @returns {Promise<{ ok: true, pending: { verifier: string, nonce: string, next: string, linkUserId: string|null } } | { ok: false, error: 'bad-state'|'expired'|'wrong-session' }>}
 */
export async function takeCallback(db, input) {
  const state = typeof input.state === 'string' ? input.state : '';
  const cookie = typeof input.cookieState === 'string' ? input.cookieState : '';
  if (!state || !cookie || !safeEqual(state, cookie)) return { ok: false, error: 'bad-state' };

  const pending = await coinpay.takePending(db, hashToken(state));
  if (!pending) return { ok: false, error: 'expired' };

  if (pending.linkUserId !== null && pending.linkUserId !== input.sessionUserId) {
    return { ok: false, error: 'wrong-session' };
  }
  return { ok: true, pending };
}

/**
 * Resolve a finished CoinPay authorization to an account.
 *
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
 * @param {{ sub: string, email: string|null, name: string|null }} profile
 * @param {{ linkUserId: string|null }} options
 * @returns {Promise<{ ok: true, userId: string, created: boolean, linked: boolean } | { ok: false, error: 'linked-elsewhere'|'already-linked'|'no-account' }>}
 */
export async function signInWithCoinpay(db, profile, options) {
  const identity = {
    sub: String(profile.sub),
    email: contactEmail(profile.email),
    name: profile.name ? String(profile.name).slice(0, 200) : null,
  };
  const existing = await coinpay.identityBySub(db, identity.sub);

  if (options.linkUserId !== null) {
    const target = await accounts.userById(db, options.linkUserId);
    if (!target) return { ok: false, error: 'no-account' };
    if (existing) {
      return String(existing.user_id) === String(target.id)
        ? { ok: true, userId: String(target.id), created: false, linked: false }
        : { ok: false, error: 'linked-elsewhere' };
    }
    if (await coinpay.identityForUser(db, String(target.id))) return { ok: false, error: 'already-linked' };
    await coinpay.insertIdentity(db, { ...identity, userId: String(target.id) });
    return { ok: true, userId: String(target.id), created: false, linked: true };
  }

  if (existing) {
    const user = await accounts.userById(db, String(existing.user_id));
    if (!user) return { ok: false, error: 'no-account' };
    await coinpay.touchIdentity(db, identity);
    return { ok: true, userId: String(user.id), created: false, linked: false };
  }

  // Never an existing account by email: a fresh one, bound to the sub.
  const user = await coinpay.insertPlaceholderUser(db, placeholderFor(identity.sub));
  await coinpay.insertIdentity(db, { ...identity, userId: user.id });
  return { ok: true, userId: user.id, created: true, linked: true };
}

/**
 * Can this account get back in without CoinPay? A proven address (sign-in
 * link) counts, and so does a passkey.
 *
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function hasOtherSignIn(db, userId) {
  const user = await accounts.userById(db, userId);
  if (!user) return false;
  if (!coinpay.isPlaceholderEmail(user.email)) return true;
  const credentials = await accounts.credentialsForUser(db, userId);
  return credentials.length > 0;
}

/**
 * Disconnect CoinPay, unless it is the only way into the account.
 *
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
 * @param {string} userId
 * @returns {Promise<{ ok: true } | { ok: false, error: 'not-linked'|'only-sign-in' }>}
 */
export async function disconnectCoinpay(db, userId) {
  if (!(await coinpay.identityForUser(db, userId))) return { ok: false, error: 'not-linked' };
  if (!(await hasOtherSignIn(db, userId))) return { ok: false, error: 'only-sign-in' };
  await coinpay.deleteIdentityForUser(db, userId);
  return { ok: true };
}

/**
 * May the account drop a passkey? Always, unless the account has no proven
 * address and no CoinPay, and this is its last passkey: then it is the only
 * way back in, and removing it would lock the account for good.
 *
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function canRemovePasskey(db, userId) {
  const user = await accounts.userById(db, userId);
  if (!user || !coinpay.isPlaceholderEmail(user.email)) return true;
  if (await coinpay.identityForUser(db, userId)) return true;
  return (await accounts.credentialsForUser(db, userId)).length > 1;
}
