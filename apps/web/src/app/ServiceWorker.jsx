'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker.
 *
 * Its own client component so the rest of the tree stays server-rendered — the
 * whole site is otherwise plain HTML with no JavaScript shipped to the browser.
 *
 * Registration is deferred to the load event: doing it during hydration
 * competes with the page's own requests for bandwidth on a mobile connection,
 * which is the exact scenario the PWA exists to serve.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // A failed registration must never break the page; the site works
        // perfectly well without offline support.
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }

    window.addEventListener('load', register);
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
