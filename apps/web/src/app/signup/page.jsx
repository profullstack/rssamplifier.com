import { redirect } from 'next/navigation';

import Toolbar from '../Toolbar.jsx';
import SignInPanels from '../SignInPanels.jsx';
import { currentUser } from '../../lib/auth.js';
import { explainSignInError } from '../../lib/signInForm.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Create an account',
  description:
    'Make an account with your email address. No password to choose, no password to forget — a link proves the address, and a passkey makes it quick after that.',
};

/**
 * Create an account.
 *
 * Mechanically this is /login: the emailed link creates the account if the
 * address is new, so there is one endpoint and one flow behind both pages.
 *
 * It still deserves its own page. "Sign in" is not an invitation, and somebody
 * who has never been here does not know that typing their address into it is
 * how they join — they go looking for a sign-up form, fail to find one, and
 * conclude there are no accounts. This is that form. It is the same form, said
 * to somebody who has not been here before.
 *
 * @param {{ searchParams: Promise<{ sent?: string, error?: string }> }} props
 */
export default async function SignupPage({ searchParams }) {
  const params = await searchParams;
  const user = await currentUser();

  if (user) redirect('/account');

  return (
    <>
      <h1>Create an account</h1>
      <p className="lede">
        Your email address is the account. There is no password to choose, and none to forget
        later.
      </p>

      {params.sent && (
        <p className="notice">
          If that address can receive mail, a link is on its way. Follow it and the account is
          made — it works once and expires in twenty minutes.
        </p>
      )}

      {params.error && <p className="notice">{explainSignInError(params.error, params.retry)}</p>}

      <SignInPanels
        from="/signup"
        emailEyebrow="Sign up with your email"
        emailButton="Send the link"
        passkeyEyebrow="Already have a passkey?"
        passkeyHint="If you have been here before and added one, use it — you do not need to type your address."
      />

      <h2>What happens next</h2>
      <ol>
        <li>We email you a link. Following it proves the address, which is all an account here is.</li>
        <li>
          The account is made on the spot — nothing else to fill in, no confirmation step to sit
          through.
        </li>
        <li>
          Add a passkey from your <a href="/account">account page</a> and that becomes the fast way
          back in. The emailed link stays as the way back when a device is gone.
        </li>
      </ol>

      <h2>What an account is for</h2>
      <p>
        Following blogs, and getting one page with their latest posts. That is the whole of it. The
        directory is public and always will be: you never need an account to read it, to{' '}
        <a href="/submit">submit a feed</a>, or to use the{' '}
        <a href="/api/feeds">JSON API</a>, <a href="/opml">OPML</a> or{' '}
        <a href="/llms.txt">llms.txt</a>.
      </p>

      <p className="hint">
        Been here before? <a href="/login">Sign in instead</a> — though the form above works either
        way.
      </p>

      <Toolbar />
    </>
  );
}
