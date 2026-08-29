/*
 * Where a feed's *page* puts its ad units — the same answer its document gets.
 *
 * A feed page and a feed document list the same posts, so a reader who meets an
 * ad after nine posts in one and never in the other has been told two different
 * things about how heavily this site advertises. `adPlan` in ./ads.js cannot
 * express that on its own: it drops a slot that would land near the end, which
 * on a ten-post blog — the commonest length in the directory by a wide margin —
 * means the page shows nothing while the document shows one. So placement comes
 * from `adPositions`, the syndication rule, and only the *format* is decided
 * here. That is the division of labour the two modules already had.
 *
 * **Why this is not in ./ads.js, where it obviously belongs.** `ads.js` is
 * imported by `AdBanner.jsx`, which is a `'use client'` component, so everything
 * that file imports is dragged into the browser bundle. `@rssamplifier/feed`'s
 * index reaches `src/fetch.js`, which imports `node:dns/promises` and
 * `node:net` — and Turbopack does not fail that softly. It fails the whole
 * build with "the chunking context does not support external modules", pointing
 * at `/page` rather than at the import that caused it. Keeping the package
 * import in a module only server components reach is what keeps that boundary
 * intact; the split is load-bearing, not stylistic.
 */

import { adPositions } from '@rssamplifier/feed';

import { AD_MREC, AD_TEXT } from './ads.js';

/**
 * Decide where a feed page's units go, and in what format.
 *
 * @param {number} total how many posts the page is about to render
 * @param {{ formats?: string[] }} [opts]
 * @returns {Map<number, string>} post index → format to render after that post
 */
export function feedAdPlan(total, { formats = [AD_MREC, AD_TEXT] } = {}) {
  const plan = new Map();

  adPositions(total).forEach((at, n) => {
    plan.set(at, formats[n % formats.length]);
  });

  return plan;
}
