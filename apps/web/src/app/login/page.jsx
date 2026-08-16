import { redirect } from 'next/navigation';

import Toolbar from '../Toolbar.jsx';
import { PasskeySignIn } from '../Passkey.jsx';
import { currentUser } from '../../lib/auth.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in',
  description: 'Sign in with a passkey, or have a link emailed to you. No password.',
};

/**
 * Sign in.
 *
 * Two ways in and no password between them. A link to the address proves the
 * address, which is all an account here is; a passkey is faster once one is
 * registered, and the link stays as the way back when a device is gone.
 *
 * @param {{ searchParams: Promise<{ sent?: string, error?: string, next?: string }> }} props
 */
export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const user = await currentUser();

  if (user) redirect('/account');

  const next = typeof params.next === 'string' && params.next.startsWith('/') ? params.next : '/account';

  return (
    <>
      <h1>Sign in</h1>
      <p className="lede">
        No password. Have a link emailed to you, or use a passkey if you have already added one.
      </p>

      {params.sent && (
        <p className="notice">
          If that address can receive mail, a sign-in link is on its way. It works once and expires
          in twenty minutes.
        </p>
      )}

      {params.error && <p className="notice">{explain(params.error)}</p>}

      <form className="submit-box" action="/api/auth/magic" method="post">
        <p className="eyebrow">Email me a link</p>
        <input
          type="email"
          name="email"
          placeholder="you@example.com"
          aria-label="Your email address"
          autoComplete="email"
          required
        />
        <div className="submit-actions">
          <button type="submit">Send the link</button>
        </div>
      </form>

      <div className="submit-box">
        <p className="eyebrow">Or use a passkey</p>
        <p className="hint">
          Works with the passkey your password manager holds — Bitwarden, 1Password, iCloud
          Keychain, a hardware key. You do not need to type your address.
        </p>
        <div className="submit-actions">
          <PasskeySignIn next={next} />
        </div>
      </div>

      <h2>Why an account</h2>
      <p>
        Only to follow blogs and get one page with their latest posts. The directory itself is
        public and always will be — nothing is put behind this.
      </p>

      <Toolbar />
    </>
  );
}

/**
 * @param {string} code
 * @returns {string}
 */
function explain(code) {
  if (code === 'invalid-or-expired') {
    return 'That link has expired or was already used. Ask for a new one.';
  }
  if (code === 'invalid-email') return 'That does not look like an email address.';
  if (code === 'email-not-configured') {
    return 'Email is not configured on this deployment, so links cannot be sent. Use a passkey.';
  }
  if (code === 'missing-token') return 'That link was incomplete. Ask for a new one.';
  return 'Something went wrong. Try again.';
}
