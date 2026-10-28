import { newsletter } from '@rssamplifier/db';

import { db } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import { newsletterStatus } from '../../lib/newsletterApi.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'The weekly digest',
  description:
    'One email a week from RSS Amplifier: new feeds in the directory, what the most-followed blogs published, and the webrings.',
};

/**
 * What the weekly digest is, when it goes, and the latest issue as it was sent.
 */
export default async function NewsletterPage() {
  const [status, user] = await Promise.all([newsletterStatus(), currentUser()]);
  const mine = user ? await newsletter.subscribed(db(), String(user.id)) : null;
  const next = new Date(status.nextSend);

  return (
    <>
      <h1>The weekly digest</h1>
      <p className="lede">
        One email a week, on {status.schedule.day === 'Mon' ? 'Mondays' : status.schedule.day} at{' '}
        {String(status.schedule.hourUtc).padStart(2, '0')}:00 UTC: feeds that joined the directory,
        what the most-followed blogs published, what readers liked, and what happened in the
        webrings. Every account gets it unless it says no; every issue has a one-click unsubscribe.
      </p>
      <p>
        Next issue: <strong>{next.toUTCString()}</strong>.{' '}
        {user ? (
          <>
            You are <strong>{mine === false ? 'not on' : 'on'}</strong> it ·{' '}
            <a href="/account#newsletter">change that</a>
          </>
        ) : (
          <>
            <a href="/signup">Make an account</a> to get it.
          </>
        )}
      </p>

      {status.latest ? (
        <>
          <h2>Latest issue: {status.latest.subject}</h2>
          <p className="hint">Week {status.latest.week}</p>
          <pre className="code-block" style={{ whiteSpace: 'pre-wrap' }}>{status.latest.text}</pre>
        </>
      ) : (
        <p className="empty">
          No issue has gone out yet. <a href="/api/v1/newsletter/preview">Preview this week's</a>.
        </p>
      )}

      <p className="hint">
        Also as data: <a href="/api/v1/newsletter">/api/v1/newsletter</a> ·{' '}
        <a href="/api/v1/newsletter/preview">/api/v1/newsletter/preview</a> · <code>rssamplifier newsletter</code>
      </p>
    </>
  );
}
