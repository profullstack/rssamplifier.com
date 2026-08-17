'use client';

import { useEffect, useState } from 'react';

/**
 * The follow toggle on a feed page or a topic page.
 *
 * Still the plain form it has always been, posting to /api/follows or
 * /api/follows/topics, because that is what every write on the site is and it
 * has to keep working with JavaScript off. What this adds is the click being
 * handled here: both endpoints already answer a JSON caller with the new
 * state, so following can flip the button in place instead of costing a full
 * navigation that re-runs the topic's queries, rebuilds sixty rows and drops
 * the reader back at the top of the page.
 *
 * The same shape as PostActions: the submit handler is the enhancement and the
 * form is the floor. Anything that goes wrong on this path — a network error,
 * a body that is not the JSON we expect — falls back to submitting the form for
 * real, so the worst case is the old behaviour rather than a click that
 * vanished.
 *
 * Both endpoints take `action` rather than toggling blind, so the hidden field
 * tracks the current state: a stale page whose button says Follow asks to
 * follow, and gets that, instead of undoing a follow made in another tab.
 *
 * @param {{
 *   endpoint: string,
 *   slug: string,
 *   segment?: string,
 *   following: boolean,
 *   signedIn: boolean,
 *   next: string,
 *   label: string,
 *   followingLabel?: string,
 * }} props
 */
export default function FollowButton({
  endpoint,
  slug,
  segment = '',
  following,
  signedIn,
  next,
  label,
  followingLabel = 'Following ✓',
}) {
  const [on, setOn] = useState(following);
  const [busy, setBusy] = useState(false);

  // The prop is the server's answer and wins whenever it changes underneath —
  // a client-side navigation to another topic reuses this component, and the
  // previous topic's state would otherwise outlive the previous topic.
  useEffect(() => setOn(following), [endpoint, slug, segment, following]);

  /** @param {React.FormEvent<HTMLFormElement>} event */
  async function onSubmit(event) {
    // Signed out, the answer is a redirect to /login and the plain form is
    // already the shortest way there. Nothing to enhance.
    if (!signedIn) return;

    event.preventDefault();
    const form = event.currentTarget;
    if (busy) return;
    setBusy(true);

    // Moved before the request, not after it: the point of doing this here is
    // that the button reacts to the finger, and the response reconciles a
    // moment later with whatever the server actually recorded.
    const wanted = !on;
    setOn(wanted);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          slug,
          // Sent only where there is one, matching the hidden field: '' is what
          // the endpoint reads as "the whole topic" either way.
          ...(segment ? { segment } : {}),
          action: wanted ? 'follow' : 'unfollow',
        }),
      });

      if (res.status === 401) {
        // The session went away while the page sat open. Sign in and come back,
        // which is what the form would have done.
        window.location.href = `/login?next=${encodeURIComponent(next)}`;
        return;
      }

      if (!res.ok) throw new Error(`follows: ${res.status}`);

      const body = await res.json();
      if (typeof body?.following !== 'boolean') throw new Error('follows: unexpected body');

      setOn(body.following);
      setBusy(false);
    } catch {
      // Put the guess back and let the browser do it the old way, so a click is
      // never silently lost. The reload replaces this component, so `busy`
      // stays set on purpose — a second click during the navigation would post
      // the same action twice.
      setOn(following);
      form.submit();
    }
  }

  return (
    <form className="follow-form" action={endpoint} method="post" onSubmit={onSubmit}>
      <input type="hidden" name="slug" value={slug} />
      {/* Present only on a sub-group, because '' is what the endpoint reads as
          "the whole topic" and a hidden field carrying it says the same thing
          less clearly. */}
      {segment && <input type="hidden" name="segment" value={segment} />}
      {/* Follows the button rather than the server's answer, so the no-JS
          submit asks for whatever the label is currently offering. */}
      <input type="hidden" name="action" value={on ? 'unfollow' : 'follow'} />
      {/* Following is the quiet state: a thing already done should not shout as
          loudly as the invitation to do it. */}
      <button
        type="submit"
        className={on ? 'secondary-button' : ''}
        // A toggle in a state, which is what a screen reader needs to hear from
        // a button whose label is the only other thing that changed.
        aria-pressed={on}
        disabled={busy}
      >
        {on ? followingLabel : label}
      </button>
    </form>
  );
}
