import { redirect } from 'next/navigation';
import { accounts, apikeys, dataset } from '@rssamplifier/db';

import Toolbar from '../Toolbar.jsx';
import { AddPasskey } from '../Passkey.jsx';
import { db } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import { topicLabel } from '../../lib/following.js';
import { ANONYMOUS_HOURLY } from '../../lib/ratelimit.js';
import { latestClosedWindow } from '../../lib/datasetWindow.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your account',
  description: 'The blogs and topics you follow, and the passkeys that get you in.',
};

/**
 * The account page: what you follow, and how you get back in.
 *
 * @param {{ searchParams: Promise<{ welcome?: string, revoked?: string, created?: string, keyRevoked?: string, keyError?: string }> }} props
 */
export default async function AccountPage({ searchParams }) {
  const params = await searchParams;
  const user = await currentUser();

  if (!user) redirect('/login');

  const client = db();
  const userId = String(user.id);

  const [follows, credentials, topics, keys, grant] = await Promise.all([
    accounts.followedFeeds(client, userId),
    accounts.credentialsForUser(client, userId),
    accounts.followedTopics(client, userId),
    apikeys.keysForUser(client, userId),
    dataset.activeGrant(client, userId),
  ]);

  // Only for an account that has one, so the overwhelming majority of readers —
  // who will never license the corpus — do not pay a query to be told they have
  // no downloads.
  const pulls = grant ? await dataset.recentDownloads(client, String(grant.id), 5) : [];

  // Revoked keys are kept in the table so a stale key found in a log can still
  // be identified, but there is nothing for their owner to do about them.
  const liveKeys = keys.filter((k) => !k.revoked_at);

  return (
    <>
      <p className="eyebrow">Signed in as {String(user.email)}</p>
      <h1>Your account</h1>

      {params.welcome && (
        <p className="notice">
          Welcome. Add a passkey below and you will not need the email link again — though it will
          keep working if you ever lose the device.
        </p>
      )}

      {params.revoked && <p className="notice">That passkey has been removed.</p>}

      <h2>Passkeys</h2>
      {credentials.length === 0 ? (
        <p className="empty">
          None yet. A passkey signs you in without waiting for an email, and your password manager
          can hold it.
        </p>
      ) : (
        <dl className="stats">
          {credentials.map((c) => (
            <div key={String(c.id)}>
              <dt>{String(c.name ?? 'Passkey')}</dt>
              <dd style={{ fontSize: '0.9rem' }}>
                {c.last_used_at ? `Last used ${formatDate(c.last_used_at)}` : 'Never used'}
                <form action="/api/auth/passkey/revoke" method="post" style={{ marginTop: '0.5rem' }}>
                  <input type="hidden" name="id" value={String(c.id)} />
                  <button type="submit">Remove</button>
                </form>
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="submit-actions">
        <AddPasskey label={credentials.length === 0 ? 'Add a passkey' : 'Add another passkey'} />
      </div>

      <h2>API keys</h2>
      <p className="hint">
        The API answers without a key — {ANONYMOUS_HOURLY} requests an hour from one address. A key
        raises that, and lets you tell your own traffic apart from everyone else&apos;s. Send it as{' '}
        <code>Authorization: Bearer …</code>.
      </p>

      {params.created && (
        <p className="notice">
          Your new key: <code>{String(params.created)}</code>
          <br />
          Copy it now. It is stored only as a hash, so this is the one and only time it can be
          shown.
        </p>
      )}

      {params.keyRevoked && <p className="notice">That key has been revoked.</p>}

      {params.keyError === 'too-many-keys' && (
        <p className="notice">
          You already hold {apikeys.MAX_KEYS_PER_USER} keys. Revoke one before creating another.
        </p>
      )}

      {params.keyError === 'unknown-key' && (
        <p className="notice">That key was already revoked, or was never yours.</p>
      )}

      {liveKeys.length === 0 ? (
        <p className="empty">None yet.</p>
      ) : (
        <dl className="stats">
          {liveKeys.map((k) => (
            <div key={String(k.id)}>
              <dt>{String(k.name)}</dt>
              <dd style={{ fontSize: '0.9rem' }}>
                <code>{String(k.prefix)}…</code>
                <br />
                {Number(k.hourly_limit)} requests/hour ·{' '}
                {k.last_used_at ? `last used ${formatDate(k.last_used_at)}` : 'never used'}
                <form action="/api/keys" method="post" style={{ marginTop: '0.5rem' }}>
                  <input type="hidden" name="action" value="revoke" />
                  <input type="hidden" name="id" value={String(k.id)} />
                  <button type="submit">Revoke</button>
                </form>
              </dd>
            </div>
          ))}
        </dl>
      )}

      <form action="/api/keys" method="post" className="submit-actions">
        <input type="hidden" name="action" value="create" />
        <input type="text" name="name" placeholder="What is it for? (e.g. my crawler)" maxLength={60} />
        <button type="submit">Create a key</button>
      </form>

      {/* Shown to every account, licensed or not, and that is deliberate. An
          account with no licence is told so in one line with a link, which is
          the answer to "did my access get set up?" — a question that otherwise
          arrives by email. There is no button here because there is nothing to
          press: a licence is written by hand after a conversation, and a page
          that implied otherwise would be promising a checkout that does not
          exist. */}
      <h2>Training data</h2>
      {grant ? (
        <>
          <p className="hint">
            This account holds a <strong>{String(grant.plan)}</strong> corpus licence, granted{' '}
            {formatDate(grant.granted_at)}
            {grant.expires_at ? ` and running until ${formatDate(grant.expires_at)}` : ''}. Pull{' '}
            {Number(grant.per_window_downloads)} times per dataset per window, and{' '}
            {Number(grant.full_dumps_per_day)} full-history dump
            {Number(grant.full_dumps_per_day) === 1 ? '' : 's'} a day. Use a session or any of your
            API keys as a bearer token — the licence belongs to the account, so rotating a key costs
            you nothing.
          </p>
          <p className="hint">
            Newest complete window: <code>{latestClosedWindow()}</code>. The shape of every row is
            at <a href="/api/dataset">/api/dataset</a>.
          </p>
          {pulls.length === 0 ? (
            <p className="empty">Nothing pulled yet.</p>
          ) : (
            <dl className="stats">
              {pulls.map((p, i) => (
                <div key={`${String(p.created_at)}-${i}`}>
                  <dt>{String(p.dataset)}</dt>
                  <dd style={{ fontSize: '0.9rem' }}>
                    {p.full_dump ? 'full history' : String(p.window_start)}
                    <br />
                    {/* A pull with no completed_at did not finish. Said plainly,
                        because it is the difference between "that window really
                        was small" and "your pipeline lost the connection", and
                        only one of those is worth investigating. */}
                    {p.completed_at
                      ? `${Number(p.rows_sent).toLocaleString('en-US')} rows · ${formatDate(p.created_at)}`
                      : `did not finish · started ${formatDate(p.created_at)}`}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      ) : (
        <p className="hint">
          This account has no corpus licence, and needs none for anything the directory serves
          openly — the API, the OPML export and the MCP server all answer without one. Bulk access
          to the whole directory as a training corpus is licensed separately:{' '}
          <a href="/sales">what is in it, and how to ask</a>.
        </p>
      )}

      {/* What is followed, but not what it published: the river moved to
          /following, which is the one place the blogs and the topics are merged
          into a single list and the only one of the two that can be subscribed
          to. Two rivers on two pages would have drifted the moment one of them
          grew a feature. */}
      <h2>Following {follows.length + topics.length > 0 && `(${follows.length + topics.length})`}</h2>
      {follows.length + topics.length === 0 ? (
        <p className="empty">
          Nothing yet. Open any blog and press Follow, or any <a href="/topics">topic</a> to be told
          when anybody writes about it — or hit <a href="/random">random</a> until something catches.
        </p>
      ) : (
        <>
          {topics.length > 0 && (
            <div className="feed-meta detail">
              {topics.map((t) => {
                const label = topicLabel(t);
                return (
                  <a key={`${t.slug}:${t.segment}`} href={label.href}>
                    {label.title}
                  </a>
                );
              })}
            </div>
          )}

          {follows.length > 0 && (
            <div className="feed-meta detail">
              {follows.map((f) => (
                <a key={String(f.slug)} href={`/${f.slug}`}>
                  {String(f.title)}
                </a>
              ))}
            </div>
          )}

          <p className="hint">
            <a href="/following">Your river →</a> everything above, newest first, and a feed URL for
            your reader.
          </p>

          {/* The other half of following: a river is a place you visit, an
              alert is a thing that arrives. Linked from here because this is
              where somebody stands when they wonder what an account is for. */}
          <p className="hint">
            <a href="/account/alerts">Alerts →</a> be told about new posts by email, in this
            browser, or at a webhook.
          </p>
        </>
      )}

      <h2>Sign out</h2>
      <p className="hint">Ends this session only — your other devices stay signed in.</p>
      <form action="/api/auth/logout" method="post">
        <button type="submit">Sign out</button>
      </form>

      <Toolbar />
    </>
  );
}

/**
 * @param {unknown} iso
 * @returns {string}
 */
function formatDate(iso) {
  if (!iso) return 'undated';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return 'undated';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
