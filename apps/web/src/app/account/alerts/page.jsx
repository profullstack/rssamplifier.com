import { redirect } from 'next/navigation';
import { alerts } from '@rssamplifier/db';
import { emailEnabled } from '@rssamplifier/mail';
import { SIGNATURE_HEADER } from '@rssamplifier/notify';

import Toolbar from '../../Toolbar.jsx';
import PushToggle from '../PushToggle.jsx';
import { db } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';
import { topicLabel } from '../../../lib/following.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Alerts',
  description: 'Where you are told about new posts from the blogs and topics you follow.',
};

/** What each error code from /api/alerts/channels means to a reader. */
const ERRORS = {
  'not-a-url': 'That did not look like a URL.',
  'https-required': 'A webhook has to be https. Alerts carry what you follow, and http carries it in the clear.',
  'private-address': 'That address only means something from inside a network, so nothing here could reach it.',
  'too-many': `You already hold ${alerts.MAX_CHANNELS_PER_USER} destinations. Remove one first.`,
  'unknown-channel': 'That destination was already gone.',
  'no-address': 'This account has no email address on it.',
  'bad-request': 'Something was missing from that.',
};

/**
 * Where alerts go, and what is switched on.
 *
 * Its own page rather than another section of /account, because it is the
 * settings half of a feature whose other half is a button on forty other pages.
 * The bell beside Follow says *whether* a blog alerts; this says *where* the
 * alerts land, and every follow shares the answer.
 *
 * @param {{ searchParams: Promise<{ added?: string, removed?: string, error?: string }> }} props
 */
export default async function AlertsPage({ searchParams }) {
  const params = await searchParams;
  const user = await currentUser();

  if (!user) redirect('/login?next=/account/alerts');

  const client = db();
  const userId = String(user.id);

  const [channels, following] = await Promise.all([
    alerts.channelsForUser(client, userId),
    alerts.alertingFollows(client, userId),
  ]);

  const hasEmail = channels.some((c) => c.kind === 'email');
  const watching = following.feeds.length + following.topics.length;

  return (
    <>
      <p className="eyebrow">
        <a href="/account">Your account</a>
      </p>
      <h1>Alerts</h1>

      <p className="hint">
        Following collects things. An alert interrupts you about them. Press 🔔 beside Follow on any
        blog or topic to have it alert, then say here where those alerts should go — the same
        destinations serve every follow.
      </p>

      {params.added === 'email' && <p className="notice">Email alerts are on.</p>}
      {params.added === 'webhook' && <p className="notice">That webhook will get your alerts.</p>}
      {params.removed && <p className="notice">That destination has been removed.</p>}
      {params.error && <p className="notice">{ERRORS[params.error] ?? 'That did not work.'}</p>}

      <h2>Where they go</h2>

      {channels.length === 0 ? (
        <p className="empty">
          Nowhere yet. Nothing will be sent until at least one of the three below is switched on.
        </p>
      ) : (
        <dl className="stats">
          {channels.map((channel) => (
            <div key={String(channel.id)}>
              <dt>{describe(channel)}</dt>
              <dd style={{ fontSize: '0.9rem' }}>
                {health(channel)}
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                  {/* Switched off keeps the row. Silencing a phone for a week
                      should not mean granting notification permission again
                      afterwards. */}
                  <form action="/api/alerts/channels" method="post">
                    <input type="hidden" name="action" value={channel.enabled ? 'disable' : 'enable'} />
                    <input type="hidden" name="id" value={String(channel.id)} />
                    <button type="submit" className="secondary-button">
                      {channel.enabled ? 'Pause' : 'Resume'}
                    </button>
                  </form>
                  <form action="/api/alerts/channels" method="post">
                    <input type="hidden" name="action" value="remove" />
                    <input type="hidden" name="id" value={String(channel.id)} />
                    <button type="submit">Remove</button>
                  </form>
                </div>
              </dd>
            </div>
          ))}
        </dl>
      )}

      <h3>This browser</h3>
      <p className="hint">
        A notification on this device, even with the site closed. Each browser is attached
        separately — a phone and a laptop are two.
      </p>
      <PushToggle />

      <h3>Email</h3>
      {emailEnabled() ? (
        hasEmail ? (
          <p className="hint">
            Going to <code>{String(user.email)}</code>. Several new posts arrive as one digest
            rather than one message each.
          </p>
        ) : (
          <form action="/api/alerts/channels" method="post" className="submit-actions">
            <input type="hidden" name="action" value="email" />
            <button type="submit">Email {String(user.email)}</button>
          </form>
        )
      ) : (
        <p className="hint">This deployment has no mail provider configured.</p>
      )}

      <h3>Webhook</h3>
      <p className="hint">
        One <code>POST</code> of JSON per batch, to your own address — for a chat relay, a
        dashboard, or a script that files them. With a secret, the body is signed as{' '}
        <code>{SIGNATURE_HEADER}: sha256=…</code>, an HMAC of the exact bytes you receive.
      </p>
      <form action="/api/alerts/channels" method="post" className="submit-actions">
        <input type="hidden" name="action" value="webhook" />
        <input type="url" name="url" placeholder="https://example.com/hooks/rss" required />
        <input type="text" name="secret" placeholder="Signing secret (optional)" maxLength={200} />
        <input type="text" name="label" placeholder="What is it? (optional)" maxLength={60} />
        <button type="submit">Add webhook</button>
      </form>

      <h2>What alerts</h2>
      {watching === 0 ? (
        <p className="empty">
          Nothing yet. Open a blog you <a href="/following">follow</a> — or any{' '}
          <a href="/topics">topic</a> — and press 🔔 beside the Follow button.
        </p>
      ) : (
        <>
          {following.topics.length > 0 && (
            <div className="feed-meta detail">
              {following.topics.map((t) => {
                const label = topicLabel(t);
                return (
                  <a key={`${t.slug}:${t.segment}`} href={label.href}>
                    {label.title}
                  </a>
                );
              })}
            </div>
          )}

          {following.feeds.length > 0 && (
            <div className="feed-meta detail">
              {following.feeds.map((f) => (
                <a key={String(f.slug)} href={`/${f.slug}`}>
                  {String(f.title)}
                </a>
              ))}
            </div>
          )}

          <p className="hint">
            {watching} {watching === 1 ? 'follow alerts' : 'follows alert'}. Everything else you
            follow is still collected at <a href="/following">your river</a>, quietly.
          </p>
        </>
      )}

      <Toolbar />
    </>
  );
}

/**
 * What a destination is called in the list.
 *
 * @param {object} channel
 * @returns {string}
 */
function describe(channel) {
  const label = String(channel.label ?? '');
  if (channel.kind === 'email') return `Email · ${String(channel.target)}`;
  if (channel.kind === 'web') return label || 'A browser';
  // The host, not the whole URL: a webhook URL often carries a token in its path,
  // and a settings page is a screen somebody might be sharing.
  return `Webhook · ${hostOf(String(channel.target))}${label ? ` (${label})` : ''}`;
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * How a destination is doing, in a line.
 *
 * A channel that has quietly stopped working is the failure mode worth naming:
 * everything else about alerts is visible by their arriving, and this is the one
 * state whose only symptom is silence.
 *
 * @param {object} channel
 * @returns {string}
 */
function health(channel) {
  if (!channel.enabled) {
    return Number(channel.failures ?? 0) > 0
      ? `Switched off after ${channel.failures} failures — ${String(channel.last_error ?? 'no detail')}`
      : 'Paused.';
  }

  if (channel.last_ok_at) return `Last delivered ${formatDate(channel.last_ok_at)}`;
  if (channel.last_error) return `Not yet delivered — ${String(channel.last_error)}`;
  return 'Nothing sent yet.';
}

/**
 * @param {unknown} iso
 * @returns {string}
 */
function formatDate(iso) {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return 'at an unknown time';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
