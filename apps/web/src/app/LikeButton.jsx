'use client';

import { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Like a ring: on or off, with the count beside it.
 *
 * The same shape as FollowButton: a plain form under the button so it works
 * with JavaScript off (the route redirects back to `next`), and a submit
 * handler that asks the same route for JSON and flips the button in place.
 * Anything that goes wrong on that path falls through to the form.
 *
 * @param {{
 *   endpoint: string,
 *   liked: boolean,
 *   likes: number,
 *   signedIn: boolean,
 *   next: string,
 *   compact?: boolean,
 * }} props
 */
export default function LikeButton({ endpoint, liked, likes, signedIn, next, compact = false }) {
  const [on, setOn] = useState(liked);
  const [count, setCount] = useState(likes);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOn(liked);
    setCount(likes);
  }, [endpoint, liked, likes]);

  /** @param {React.FormEvent<HTMLFormElement>} event */
  async function onSubmit(event) {
    if (!signedIn) return;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const want = !on;
    // Optimistic: the button answers the click, the server confirms.
    setOn(want);
    setCount((c) => Math.max(0, c + (want ? 1 : -1)));
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action: want ? 'like' : 'unlike', next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (typeof body?.liked === 'boolean') setOn(body.liked);
      if (typeof body?.likes === 'number') setCount(body.likes);
    } catch {
      event.currentTarget?.submit?.();
    } finally {
      setBusy(false);
    }
  }

  const label = on ? 'Liked' : 'Like';
  return (
    <form className="m-0" action={endpoint} method="post" onSubmit={onSubmit}>
      <input type="hidden" name="action" value={on ? 'unlike' : 'like'} />
      <input type="hidden" name="next" value={next} />
      <button
        type="submit"
        disabled={busy}
        aria-pressed={on}
        title={signedIn ? `${label} this ring` : 'Sign in to like this ring'}
        className={cn(
          buttonVariants({ variant: on ? 'default' : 'outline', size: compact ? 'icon' : 'sm' }),
          compact && 'size-8',
        )}
      >
        <Heart className={on ? 'fill-current' : ''} />
        {compact ? (
          <span className="sr-only">
            {label}, {count}
          </span>
        ) : (
          <>
            {label} <span className="tabular-nums opacity-80">{count}</span>
          </>
        )}
      </button>
    </form>
  );
}
