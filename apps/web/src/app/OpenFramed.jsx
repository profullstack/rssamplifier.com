'use client';

import { useEffect, useState } from 'react';

/**
 * "Open ↗", pointed at where the reader actually is.
 *
 * Links inside the frame work now, which means the reader can be three pages
 * into a blog's archive while the toolbar still offers to open the post they
 * started on. That is a worse lie than the old broken link: it looks right.
 *
 * The frame runs with no origin, so it cannot reach up and change this itself.
 * What it can do is post a message, which every page served through /api/frame
 * does on parse, and this listens for it.
 *
 * The check that matters is `event.source`: a sandboxed document has an opaque
 * origin, so `event.origin` is the string "null" and worth nothing, while
 * identity of the sending window cannot be forged by another tab. Anything
 * that is not this page's own frame is ignored, and so is anything that is not
 * an http(s) URL.
 *
 * @param {{ href: string }} props the post's own URL, and where this starts
 */
export default function OpenFramed({ href }) {
  const [at, setAt] = useState(href);

  // The post changes under a client component that survives the navigation, so
  // the starting point has to be reset when it does — otherwise the previous
  // post's frame position outlives the previous post.
  useEffect(() => setAt(href), [href]);

  useEffect(() => {
    /** @param {MessageEvent} event */
    function onMessage(event) {
      const frame = document.querySelector('iframe.reader-frame');
      if (!frame || event.source !== frame.contentWindow) return;

      const data = event.data;
      if (!data || data.source !== 'rssamplifier-reader') return;

      const url = String(data.url ?? '');
      if (/^https?:\/\//i.test(url)) setAt(url);
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const moved = at !== href;

  return (
    <a
      href={at}
      target="_blank"
      rel="noopener"
      title={moved ? `Open ${hostOf(at)}` : 'Open the original page'}
    >
      <span className="label">Open</span>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
