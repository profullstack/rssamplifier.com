'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Share2 } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Share a ring: the share sheet where there is one, the clipboard where
 * there is not, and a word back either way. Once the link has gone
 * somewhere, the share is reported to `beacon` so it counts.
 *
 * @param {{ url: string, title: string, beacon?: string, member?: string, compact?: boolean }} props
 */
export default function ShareButton({ url, title, beacon = '', member = '', compact = false }) {
  const [said, setSaid] = useState('');
  const [native, setNative] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    setNative(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  /** @param {string} message */
  function say(message) {
    setSaid(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(''), 2000);
  }

  function count() {
    if (!beacon) return;
    try {
      fetch(beacon, {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ member }),
      }).catch(() => {});
    } catch {
      // A share that could not be counted was still a share.
    }
  }

  async function share() {
    if (native) {
      try {
        await navigator.share({ title, url });
        say('Shared');
        count();
      } catch {
        // Dismissed, or refused: nothing to report.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      say('Link copied');
      count();
    } catch {
      say('Press ⌘C or Ctrl+C');
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      title={said || (native ? 'Share this ring' : 'Copy the link to this ring')}
      aria-live="polite"
      className={cn(buttonVariants({ variant: 'outline', size: compact ? 'icon' : 'sm' }), compact && 'size-8')}
    >
      {said ? <Check /> : <Share2 />}
      {compact ? <span className="sr-only">{said || 'Share'}</span> : said || 'Share'}
    </button>
  );
}
