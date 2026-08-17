import { redirect } from 'next/navigation';
import { accounts, apikeys } from '@rssamplifier/db';

import Toolbar from '../Toolbar.jsx';
import { AddPasskey } from '../Passkey.jsx';
import { db } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import { ANONYMOUS_HOURLY } from '../../lib/ratelimit.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your account',
  description: 'The blogs you follow, and the passkeys that get you in.',
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

  const [follows, credentials, latest, keys] = await Promise.all([
    accounts.followedFeeds(client, userId),
    accounts.credentialsForUser(client, userId),
    accounts.followedItems(client, userId, 40),
    apikeys.keysForUser(client, userId),
  ]);

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

      <h2>Following {follows.length > 0 && `(${follows.length})`}</h2>
      {follows.length === 0 ? (
        <p className="empty">
          Nothing yet. Open any blog and press Follow — or hit <a href="/random">random</a> until
          something catches.
        </p>
      ) : (
        <div className="feed-meta detail">
          {follows.map((f) => (
            <a key={String(f.slug)} href={`/${f.slug}`}>
              {String(f.title)}
            </a>
          ))}
        </div>
      )}

      {latest.length > 0 && (
        <>
          <h2>Latest from what you follow</h2>
          {latest.map((p) => (
            <article className="entry" key={`${p.feed_slug}-${p.guid}`}>
              <h3>
                <a href={`/${p.feed_slug}/read?p=${encodeURIComponent(String(p.guid))}`}>
                  {String(p.title)}
                </a>
              </h3>
              {p.summary && <p>{String(p.summary)}</p>}
              <time dateTime={p.published_at ? String(p.published_at) : undefined}>
                {formatDate(p.published_at)} · {String(p.feed_title)}
              </time>
            </article>
          ))}
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
