import { newsletter } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your weekly digest',
  robots: { index: false, follow: false },
};

/**
 * Where the unsubscribe link lands: says what happened, and offers the way
 * back. Works signed out: the link's token is the credential.
 *
 * @param {{ searchParams: Promise<{ u?: string, t?: string, done?: string }> }} props
 */
export default async function ManageNewsletter({ searchParams }) {
  const { u = '', t = '', done = '' } = await searchParams;
  const user = await newsletter.userForToken(db(), String(u), String(t));

  if (!user) {
    return (
      <>
        <h1>That link does not work</h1>
        <p className="lede">
          It may be from an old email or cut short. Sign in and use your{' '}
          <a href="/account#newsletter">account page</a> to change the weekly digest.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>{user.subscribed ? 'You are on the weekly digest' : 'You are unsubscribed'}</h1>
      <p className="lede">
        {user.subscribed
          ? `${user.email} gets the RSS Amplifier digest every Monday.`
          : `${user.email} will not get the weekly RSS Amplifier digest again. Nothing else changes: your account and follows are as they were.`}
      </p>
      {done === 'on' && <p className="notice">Welcome back.</p>}
      <form method="post" action={user.subscribed ? `/newsletter/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}` : '/newsletter/resubscribe'}>
        <input type="hidden" name="u" value={u} />
        <input type="hidden" name="t" value={t} />
        <button type="submit">{user.subscribed ? 'Unsubscribe' : 'Re-subscribe'}</button>
      </form>
      <p className="hint">
        <a href="/newsletter">What the digest is</a> · <a href="/account#newsletter">Account settings</a>
      </p>
    </>
  );
}
