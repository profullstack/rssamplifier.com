'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const SAID = {
  recent: () => 'Already read in the last few minutes.',
  read: (r) => (r.newItems > 0 ? `${r.newItems} new ${r.newItems === 1 ? 'post' : 'posts'}.` : 'Read just now: nothing new.'),
  unchanged: () => 'Read just now: nothing new.',
  queued: () => 'Queued: this source is read by the crawler, first in line.',
  reading: () => 'Still reading; this page will catch up shortly.',
  throttled: () => 'The publisher asked us to slow down; try again later.',
  failed: (r) => `Could not read it: ${r.error ?? 'the publisher did not answer'}.`,
  dead: (r) => r.error,
};

/**
 * Read this feed now instead of waiting for its turn. POSTs to
 * /api/feeds/<slug>/refresh, which runs the crawler's own read, then re-renders
 * the page so new posts and the freshness line show up in place.
 *
 * @param {{ slug: string }} props
 */
export default function RefreshFeed({ slug }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');

  async function refresh() {
    setBusy(true);
    setSaid('Reading the feed…');
    try {
      const res = await fetch(`/api/feeds/${encodeURIComponent(slug)}/refresh`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      setSaid((SAID[body.state] ?? SAID.failed)(body));
      if (body.ok) router.refresh();
    } catch {
      setSaid('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <p className="refresh-feed">
      <button type="button" className="refresh-feed-button" onClick={refresh} disabled={busy}>
        {busy ? 'Refreshing…' : 'Refresh feed'}
      </button>
      <span className="refresh-feed-said" aria-live="polite">
        {said}
      </span>
    </p>
  );
}
