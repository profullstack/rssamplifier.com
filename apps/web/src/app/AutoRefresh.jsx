'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-render a server page on an interval, without a full reload.
 *
 * router.refresh() re-runs the server component and swaps in the new markup, so
 * the numbers move while scroll position, focus and the rest of the page stay
 * where they were. A meta refresh would do the same job by throwing the page
 * away, which on a status board you are watching is exactly wrong.
 *
 * Refreshing pauses while the tab is hidden: a status page left open in a
 * background tab overnight should not poll the database 3,000 times.
 *
 * @param {{ seconds?: number }} props
 */
export default function AutoRefresh({ seconds = 15 }) {
  const router = useRouter();

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };

    const timer = setInterval(tick, Math.max(5, seconds) * 1000);
    // Coming back to the tab should show current numbers immediately, rather
    // than whatever was true when it was hidden.
    document.addEventListener('visibilitychange', tick);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [router, seconds]);

  return null;
}
