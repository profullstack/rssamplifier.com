import { social } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'X collection status',
  description: 'Which provider is collecting X posts, how it is doing, and how stale anything is.',
  // A status board is not a page to rank; it is a page to check.
  robots: { index: false, follow: true },
};

/**
 * How X collection is going (§32, §33, §34).
 *
 * **Read-only, and deliberately so.** §34 asks for a `/admin/x` with buttons to
 * disable a provider, clear a cooldown and force a refresh. This codebase has
 * no notion of an administrator at all — no role column, no admin route, no
 * guard to hang one on — so those buttons would have to arrive with an
 * authorisation system, and shipping the levers ahead of the lock is how a
 * kill switch becomes a way for anybody to turn collection off. The
 * environment already holds the two that matter: `X_ENABLED` stops collection
 * entirely and `X_PRIMARY_PROVIDER` re-orders the stack, both without a deploy
 * of code. The buttons are the part left undone, and this is where they go.
 *
 * **It is a lagging view, not a probe.** The web service never collects
 * anything; the poller does, and writes what happened to `x_provider_state`.
 * So this page reads that table and says when it was last written rather than
 * asking a provider how it is right now — which is also the only way to render
 * it without spending an upstream request per page view (§32).
 *
 * Nothing here is a secret. Session ids are names, not credentials; the tokens
 * live in the environment and are not in the database to leak (AC-7).
 */
export default async function XStatusPage() {
  const client = db();

  const [providers, sessions, counts, stale] = await Promise.all([
    social.providerStates(client),
    social.sessionStates(client),
    social.countSocialFeeds(client, 'x'),
    social.countStaleSocialFeeds(client, 'x'),
  ]);

  return (
    <main className="prose">
      <h1>X collection status</h1>

      <p>
        {counts.total.toLocaleString()} X sources, {counts.crawled.toLocaleString()} collected at
        least once, {stale.toLocaleString()} overdue by more than three of their own refresh
        intervals. Overdue is judged on when we last <em>read</em> a source, never on when it
        last posted — a quiet account is quiet, not broken.
      </p>

      <h2>Providers</h2>

      {providers.length === 0 ? (
        <p>
          No provider has reported yet. Either collection is switched off (<code>X_ENABLED</code>)
          or the poller has not run a crawl since this table was created.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Status</th>
              <th>Last success</th>
              <th>Failures</th>
              <th>Cooldown until</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((row) => (
              <tr key={String(row.provider)}>
                <td>{String(row.provider)}</td>
                <td>{String(row.status ?? 'unknown')}</td>
                <td>{row.last_success_at ? String(row.last_success_at) : '—'}</td>
                <td>{Number(row.consecutive_failures ?? 0)}</td>
                <td>{row.cooldown_until ? String(row.cooldown_until) : '—'}</td>
                <td>{row.error_message ? String(row.error_message) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p>
        Which of these answered any particular post is not recorded against the post, and that is
        the point: <code>{siteUrl()}/x/OpenAI.rss</code> is the same address whichever provider
        filled it, so a subscriber never has to know one failed over to another.
      </p>

      <h2>Sessions</h2>

      {sessions.length === 0 ? (
        <p>
          No X sessions are configured. The unofficial providers need a logged-in session to
          collect anything; the official API provider does not.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Status</th>
              <th>Last used</th>
              <th>Failures</th>
              <th>Cooldown until</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((row) => (
              <tr key={String(row.id)}>
                <td>{String(row.id)}</td>
                <td>{String(row.status ?? 'healthy')}</td>
                <td>{row.last_used_at ? String(row.last_used_at) : '—'}</td>
                <td>{Number(row.consecutive_failures ?? 0)}</td>
                <td>{row.cooldown_until ? String(row.cooldown_until) : '—'}</td>
                <td>{row.last_error ? String(row.last_error) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p>
        An <code>expired</code> session has had its credentials rejected and will not come back on
        its own — a cookie that has been invalidated does not become valid again after a wait, so
        it stays out until it is replaced in <code>X_SESSIONS</code>. A{' '}
        <code>rate_limited</code> or <code>cooldown</code> session returns by itself when its
        cooldown runs out.
      </p>

      <p>
        <a href="/x">Back to X</a> · <a href="/crawlstats">Crawler status</a>
      </p>
    </main>
  );
}
