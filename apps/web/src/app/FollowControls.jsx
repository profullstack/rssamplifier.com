'use client';

import { useEffect, useState } from 'react';

import FollowButton from './FollowButton.jsx';

/**
 * Follow, and — once you do — whether to be told.
 *
 * The two belong side by side because they are one decision made in two steps:
 * "collect this for me" and "and interrupt me about it". Following alone has
 * always meant the first; the bell is the second, and putting it anywhere but
 * next to the button that produced it would mean a reader has to go looking for
 * a setting they did not know existed.
 *
 * A client component because the bell appears in response to the follow button,
 * which flips in place rather than reloading. The state has to live somewhere
 * both can see, and the alternative — a reload just to reveal a second control —
 * is exactly what FollowButton was written to avoid.
 *
 * @param {{
 *   endpoint: string,
 *   kind: 'feed'|'topic'|'author',
 *   slug: string,
 *   segment?: string,
 *   following: boolean,
 *   alerts: boolean,
 *   signedIn: boolean,
 *   next: string,
 *   label: string,
 *   followingLabel?: string,
 * }} props
 */
export default function FollowControls({
  endpoint,
  kind,
  slug,
  segment = '',
  following,
  alerts,
  signedIn,
  next,
  label,
  followingLabel,
}) {
  const [isFollowing, setFollowing] = useState(following);

  useEffect(() => setFollowing(following), [endpoint, slug, segment, following]);

  return (
    <>
      <FollowButton
        endpoint={endpoint}
        slug={slug}
        segment={segment}
        following={following}
        signedIn={signedIn}
        next={next}
        label={label}
        followingLabel={followingLabel}
        onChange={setFollowing}
      />

      {/* Only while following, and only for someone with an account. There is
          nothing coherent to offer a signed-out visitor here: the follow button
          sends them to sign in, and a bell beside it would be a second thing to
          explain before they have done the first. */}
      {signedIn && isFollowing && (
        <AlertBell kind={kind} slug={slug} segment={segment} alerts={alerts} next={next} />
      )}
    </>
  );
}

/**
 * The bell: whether this follow is worth interrupting somebody for.
 *
 * Same shape as everything else on the site — a plain form that works with
 * JavaScript off, with the click handled here so it flips in place. Where the
 * alerts actually go is an account-level question and lives at /account/alerts;
 * this only says whether this one follow feeds them.
 *
 * @param {{
 *   kind: 'feed'|'topic'|'author',
 *   slug: string,
 *   segment?: string,
 *   alerts: boolean,
 *   next: string,
 * }} props
 */
function AlertBell({ kind, slug, segment = '', alerts, next }) {
  const [on, setOn] = useState(alerts);
  const [busy, setBusy] = useState(false);

  useEffect(() => setOn(alerts), [kind, slug, segment, alerts]);

  /** @param {React.FormEvent<HTMLFormElement>} event */
  async function onSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (busy) return;
    setBusy(true);

    const wanted = !on;
    setOn(wanted);

    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ kind, slug, ...(segment ? { segment } : {}), alerts: wanted }),
      });

      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(next)}`;
        return;
      }

      if (!res.ok) throw new Error(`alerts: ${res.status}`);

      const body = await res.json();
      if (typeof body?.alerts !== 'boolean') throw new Error('alerts: unexpected body');

      setOn(body.alerts);
      setBusy(false);
    } catch {
      // Same fallback as the follow button: put the guess back and let the
      // browser post the form for real, so a click is never silently lost.
      setOn(alerts);
      form.submit();
    }
  }

  return (
    <form className="follow-form" action="/api/alerts" method="post" onSubmit={onSubmit}>
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="slug" value={slug} />
      {segment && <input type="hidden" name="segment" value={segment} />}
      <input type="hidden" name="alerts" value={on ? '0' : '1'} />
      <input type="hidden" name="next" value={next} />
      <button
        type="submit"
        // Off is the quiet state here, which is the opposite way round from
        // Follow: alerts are the louder thing to have switched on, so the button
        // is loud when it is on and quiet when it is the invitation.
        className={on ? '' : 'secondary-button'}
        aria-pressed={on}
        // The label is an icon and a word; the icon alone reads as decoration to
        // a screen reader and as a mystery to everyone else.
        title={on ? 'You are alerted about new posts here' : 'Be alerted about new posts here'}
        disabled={busy}
      >
        {on ? '🔔 Alerts on' : '🔕 Alerts off'}
      </button>
    </form>
  );
}
