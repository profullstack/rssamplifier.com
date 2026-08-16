import { accounts, nowIso } from '@rssamplifier/db';
import { sendEmail, emailEnabled } from '@rssamplifier/mail';

import { newToken, hashToken } from './tokens.js';

/**
 * Sign-in by emailed link.
 *
 * This is the only way into an account from nothing, and it doubles as
 * registration: proving you can read an address is the entire requirement, so
 * an unknown address makes the account rather than being turned away to find a
 * sign-up form. Passkeys are added afterwards and become the fast path; the
 * link stays as the way back in when a device is lost.
 */

/** Twenty minutes. A link left in an inbox should stop being a key fairly quickly. */
const TOKEN_MS = 20 * 60 * 1000;

/** Links per address per hour, before we stop sending. */
const MAX_PER_HOUR = 5;

/**
 * Loose enough to accept real addresses, strict enough to reject a blank field.
 *
 * Validating email properly is a fool's errand; the send either arrives or it
 * does not, and that is the real check.
 */
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/**
 * @param {unknown} email
 * @returns {boolean}
 */
export function looksLikeEmail(email) {
  const value = String(email ?? '').trim();
  return value.length <= 254 && EMAIL_RE.test(value);
}

/**
 * Issue a sign-in link and email it.
 *
 * The result never says whether the address has an account. Answering that
 * would turn this endpoint into a way to test which addresses are registered,
 * and there is no reason to hand that out — the caller shows the same "check
 * your email" either way.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} email
 * @param {string} siteUrl
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function requestSignInLink(db, email, siteUrl) {
  if (!looksLikeEmail(email)) return { ok: false, error: 'invalid-email' };
  if (!emailEnabled()) return { ok: false, error: 'email-not-configured' };

  const normalized = accounts.normalizeEmail(email);

  const recent = await accounts.recentLoginTokenCount(db, normalized);
  if (recent >= MAX_PER_HOUR) return { ok: false, error: 'rate-limited' };

  const token = newToken();
  await accounts.insertLoginToken(db, {
    tokenHash: hashToken(token),
    email: normalized,
    expiresAt: nowIso(TOKEN_MS),
  });

  const link = `${String(siteUrl).replace(/\/+$/, '')}/auth/magic?t=${encodeURIComponent(token)}`;

  const sent = await sendEmail({
    to: normalized,
    subject: 'Your RSS Amplifier sign-in link',
    text: [
      'Here is your sign-in link for RSS Amplifier:',
      '',
      link,
      '',
      'It works once and expires in 20 minutes.',
      'If you did not ask for this, you can ignore it — nothing has changed.',
    ].join('\n'),
  });

  if (!sent.ok) return { ok: false, error: sent.error ?? 'send-failed' };
  return { ok: true };
}

/**
 * Spend a link and return the account it belongs to.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} token
 * @returns {Promise<{ ok: true, userId: string, email: string, created: boolean } | { ok: false, error: string }>}
 */
export async function consumeSignInLink(db, token) {
  if (!token) return { ok: false, error: 'missing-token' };

  const email = await accounts.consumeLoginToken(db, hashToken(token));
  // One message for expired, already-used and never-existed alike: they are the
  // same situation from the reader's side — ask for a new link.
  if (!email) return { ok: false, error: 'invalid-or-expired' };

  const user = await accounts.findOrCreateUser(db, email);
  return { ok: true, userId: user.id, email: user.email, created: user.created };
}
