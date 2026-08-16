/*
 * Ad inventory.
 *
 * One CrawlProof slot serves the whole site; the *format* is what varies by
 * position, and each format has a job:
 *
 *   text_link       native, 40px, full width. Reads as a line of the page, so
 *                   it is the only unit allowed above content or inside a list
 *                   of rows — it never displaces a heading or a call to action.
 *   banner_300x250  the medium rectangle. Best-performing box in the set, but
 *                   it is a box: it only goes where a reader is already
 *                   stopping, i.e. partway down a run of posts.
 *   banner_728x90   leaderboard, wide screens only.
 *   banner_320x50   the same job on a phone. Picked at runtime by <AdBanner>,
 *                   never by rendering both and hiding one — a hidden unit
 *                   still fills, and burns an impression nobody sees.
 *
 * The slot also advertises `terminal_ascii`, which crawlproof serves as
 * text/plain to CLI clients. ad.js has no size for it and cannot render it in a
 * browser, so it is deliberately unused here.
 *
 * Deliberately *not* monetised: /llms.txt, /opml, /api/* and the rest of the
 * machine-readable surface (the clean copy for agents is the product's whole
 * pitch), the framed reader (someone else's article — see the reader page), and
 * /offline (no network, so the request could not succeed anyway).
 */

export const AD_SLOT = '2768fe0d-c51c-4629-8d86-0efba3d9ec1f';

export const AD_MREC = 'banner_300x250';
export const AD_TEXT = 'text_link';

/**
 * Decide where ads go inside a list, and in what format.
 *
 * Two rules do the work. A short list gets nothing — a page with six rows on it
 * cannot carry an ad without the ad becoming the page. And the formats
 * alternate, so a long run of posts never turns into a column of identical
 * boxes.
 *
 * @param {number} total how many items the list is about to render
 * @param {{ first: number, every: number, max?: number, formats?: string[] }} opts
 *   `first` is the index to place after, counting from 0; `every` is the gap
 *   between units thereafter.
 * @returns {Map<number, string>} item index → format to render after that item
 */
export function adPlan(total, { first, every, max = 3, formats = [AD_MREC, AD_TEXT] }) {
  const plan = new Map();

  // Nothing to interleave unless there is a real run of content below the
  // first slot — otherwise the "in-feed" unit is really just a footer ad.
  if (total <= first + 1) return plan;

  for (let i = first, n = 0; i < total - 1 && n < max; i += every, n += 1) {
    plan.set(i, formats[n % formats.length]);
  }

  return plan;
}
