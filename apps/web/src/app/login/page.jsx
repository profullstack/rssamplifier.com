import { redirect } from 'next/navigation';

import Toolbar from '../Toolbar.jsx';
import SignInPanels from '../SignInPanels.jsx';
import { currentUser } from '../../lib/auth.js';
import { explainSignInError } from '../../lib/signInForm.js';

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
 * Because the link makes the account when the address is new, this page also
 * works perfectly well for somebody who has never been here — but it does not
 * *read* that way, which is what /signup is for.
 *
 * @param {{ searchParams: Promise<{ sent?: string, error?: string, next?: string }> }} props
 */
export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const user = await currentUser();

  if (user) redirect('/account');

  const next =
    typeof params.next === 'string' && params.next.startsWith('/') ? params.next : '/account';

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

      {params.error && <p className="notice">{explainSignInError(params.error, params.retry)}</p>}

      <SignInPanels
        from="/login"
        next={next}
        emailEyebrow="Email me a link"
        emailButton="Send the link"
        passkeyEyebrow="Or use a passkey"
        passkeyHint="Works with the passkey your password manager holds — Bitwarden, 1Password, iCloud Keychain, a hardware key. You do not need to type your address."
      />

      <h2>Why an account</h2>
      <p>
        Only to follow blogs and get one page with their latest posts. The directory itself is
        public and always will be — nothing is put behind this.
      </p>

      <p className="hint">
        First time here? <a href="/signup">Create an account</a> — the form above does it too, but
        that page explains what you are getting.
      </p>

      <Toolbar />
    </>
  );
}
