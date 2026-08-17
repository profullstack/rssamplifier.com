'use client';

import { useEffect, useState } from 'react';

/**
 * Like, upvote and downvote for one post.
 *
 * Still plain forms posting to /api/reactions, because that is what every
 * control on the site is and it has to keep working with JavaScript off. What
 * this adds is the click being handled here instead: /api/reactions already
 * answers JSON callers with the new state, so a vote can move the score in
 * place rather than costing a round trip that rebuilds the reader, refetches
 * the article and drops the frame back to the top of the post.
 *
 * The submit handler is the enhancement and the form is the floor. Anything
 * that goes wrong on this path — a network error, a response that is not the
 * JSON we expect — falls back to submitting the form for real, so the worst
 * case is the old behaviour rather than a click that vanished.
 *
 * A like and a vote say different things and are kept apart on purpose. The
 * like is private — it puts the post on the reader's own shelf at /favorites —
 * while the votes are public and move a score everybody sees. Saving something
 * to read again should not require endorsing it.
 *
 * @param {{
 *   slug: string,
 *   guid: string,
 *   score: number,
 *   liked: boolean,
 *   vote: number,
 *   signedIn: boolean,
 * }} props
 */
export default function PostActions({ slug, guid, score, liked, vote, signedIn }) {
  const [state, setState] = useState({ score, liked, vote });
  const [busy, setBusy] = useState(false);

  // The reader keeps this component mounted across a navigation to the next
  // post, so the props change under it and the previous post's score would
  // otherwise outlive the previous post.
  useEffect(() => setState({ score, liked, vote }), [slug, guid, score, liked, vote]);

  /**
   * @param {React.FormEvent<HTMLFormElement>} event
   * @param {string} action
   */
  async function onSubmit(event, action) {
    // Signed out, the answer is a redirect to /login, and the plain form is
    // already the shortest way there. Nothing to enhance.
    if (!signedIn) return;

    event.preventDefault();
    const form = event.currentTarget;
    if (busy) return;
    setBusy(true);

    // Moved before the request, not after it: the point of doing this here is
    // that the button reacts to the finger, and the response reconciles a
    // moment later with whatever the server actually recorded.
    const guessed = predict(state, action);
    setState(guessed);

    try {
      const res = await fetch('/api/reactions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ slug, guid, action }),
      });

      if (res.status === 401) {
        // The session went away while the page sat open. Send them to sign in
        // and back to the post, which is what the form would have done.
        window.location.href = `/login?next=${encodeURIComponent(`/${slug}/read?p=${guid}`)}`;
        return;
      }

      if (!res.ok) throw new Error(`reactions: ${res.status}`);

      const body = await res.json();
      if (typeof body?.score !== 'number' || typeof body?.vote !== 'number') {
        throw new Error('reactions: unexpected body');
      }

      setState({ score: body.score, liked: Boolean(body.liked), vote: body.vote });
      setBusy(false);
    } catch {
      // Put the guess back and let the browser do it the old way, so a click
      // is never silently lost. The reload replaces this component, so `busy`
      // stays set on purpose — a second click during the navigation would post
      // the same action twice, and an identical vote posted twice undoes it.
      setState({ score, liked, vote });
      form.submit();
    }
  }

  return (
    <div className="post-actions">
      <Action
        slug={slug}
        guid={guid}
        action="up"
        className={`vote up${state.vote === 1 ? ' on' : ''}`}
        label="Upvote"
        // aria-pressed tells a screen reader the button is a toggle in a state,
        // which is the whole meaning of a vote control.
        pressed={state.vote === 1}
        busy={busy}
        onSubmit={onSubmit}
      >
        <span aria-hidden="true">▲</span>
      </Action>

      <span
        className={`score${state.score > 0 ? ' positive' : state.score < 0 ? ' negative' : ''}`}
        // The number changes without the page changing, so a screen reader that
        // is not looking at it is told it moved.
        aria-live="polite"
      >
        {state.score > 0 ? `+${state.score}` : String(state.score)}
      </span>

      <Action
        slug={slug}
        guid={guid}
        action="down"
        className={`vote down${state.vote === -1 ? ' on' : ''}`}
        label="Downvote"
        pressed={state.vote === -1}
        busy={busy}
        onSubmit={onSubmit}
      >
        <span aria-hidden="true">▼</span>
      </Action>

      <span className="sep" aria-hidden="true" />

      <Action
        slug={slug}
        guid={guid}
        action={state.liked ? 'unlike' : 'like'}
        className={`like${state.liked ? ' on' : ''}`}
        label={state.liked ? 'Remove from favorites' : 'Save to favorites'}
        pressed={state.liked}
        busy={busy}
        onSubmit={onSubmit}
      >
        <span aria-hidden="true">{state.liked ? '♥' : '♡'}</span>
        <span className="label">{state.liked ? 'Favorited' : 'Like'}</span>
      </Action>

      {!signedIn && (
        <span className="hint">
          <a href={`/login?next=${encodeURIComponent(`/${slug}/read?p=${guid}`)}`}>Sign in</a> to
          vote or save
        </span>
      )}
    </div>
  );
}

/**
 * What the server is about to say, worked out locally.
 *
 * The rules are the endpoint's own: an identical vote clicked twice means
 * undo, and a vote flipped from one side to the other moves the score by two.
 * Getting this wrong is cheap — the response overwrites it a moment later —
 * but getting it right is what makes the click feel like it landed.
 *
 * @param {{ score: number, liked: boolean, vote: number }} current
 * @param {string} action
 * @returns {{ score: number, liked: boolean, vote: number }}
 */
function predict(current, action) {
  if (action === 'like') return { ...current, liked: true };
  if (action === 'unlike') return { ...current, liked: false };

  const wanted = action === 'up' ? 1 : action === 'down' ? -1 : 0;
  const next = current.vote === wanted ? 0 : wanted;
  return { ...current, vote: next, score: current.score - current.vote + next };
}

/**
 * One button, as its own form.
 *
 * @param {{
 *   slug: string,
 *   guid: string,
 *   action: string,
 *   className: string,
 *   label: string,
 *   pressed: boolean,
 *   busy: boolean,
 *   onSubmit: (event: React.FormEvent<HTMLFormElement>, action: string) => void,
 *   children: React.ReactNode,
 * }} props
 */
function Action({ slug, guid, action, className, label, pressed, busy, onSubmit, children }) {
  return (
    <form
      method="post"
      action="/api/reactions"
      className="inline-form"
      onSubmit={(event) => onSubmit(event, action)}
    >
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="guid" value={guid} />
      <input type="hidden" name="action" value={action} />
      <button
        type="submit"
        className={className}
        title={label}
        aria-label={label}
        aria-pressed={pressed}
        disabled={busy}
      >
        {children}
      </button>
    </form>
  );
}
