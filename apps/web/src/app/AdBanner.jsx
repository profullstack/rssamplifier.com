'use client';

import { useEffect, useRef } from 'react';

import { AD_SLOT } from '../lib/ads.js';

/**
 * The one responsive position: a leaderboard on a desktop, a mobile banner on a
 * phone.
 *
 * The obvious way to build this — render a 728x90 and a 320x50 and hide one
 * with a media query — is the wrong way. ad.js fills every [data-cp-ad] it can
 * see whether or not CSS is showing it, so the hidden unit still requests a
 * creative and still counts as an impression that nobody could have looked at.
 * It costs the advertiser a view and drags the slot's click rate down with it.
 *
 * So: one element, and the format is chosen from the viewport at mount.
 *
 * The slot id is withheld from the server-rendered markup and only attached
 * here, which is what keeps that safe. ad.js's own DOMContentLoaded pass sees
 * an element with no data-slot and skips it (fill() returns early), and the
 * scan we trigger afterwards is the one that fills it — exactly once, since
 * fill() latches on data-cp-filled.
 *
 * @param {{ className?: string }} props
 */
export default function AdBanner({ className = '' }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.dataset.slot) return undefined;

    // 48rem is where the page has room for a 728px unit without the iframe
    // being squeezed under max-width and clipping its own creative.
    el.dataset.format = window.matchMedia('(min-width: 48rem)').matches
      ? 'banner_728x90'
      : 'banner_320x50';
    el.dataset.slot = AD_SLOT;

    if (window.crawlproofAds) {
      window.crawlproofAds.scan();
      return undefined;
    }

    // ad.js loads afterInteractive, so it may not have run yet. Poll for it,
    // but bounded — when an ad blocker eats the script it never arrives, and an
    // unbounded timer would sit there for the life of the page.
    let tries = 0;
    const timer = setInterval(() => {
      if (window.crawlproofAds) {
        window.crawlproofAds.scan();
        clearInterval(timer);
      } else if ((tries += 1) > 20) {
        clearInterval(timer);
      }
    }, 150);

    return () => clearInterval(timer);
  }, []);

  return <div ref={ref} data-cp-ad="" className={`ad ad-banner${className ? ` ${className}` : ''}`} />;
}
