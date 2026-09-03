import { extracts } from '@rssamplifier/db';
import { probePage, readableArticle } from '@rssamplifier/feed';

import { db, siteUrl } from './db.js';
import { withPageSlot } from './pageGate.js';

/**
 * What the reader can show for a post: the frame, or the article itself.
 *
 * The reader's first choice is still the publisher's own page in an iframe.
 * Most of the web refuses to be framed, though, and the answer to that refusal
 * used to be a card, a one-line summary and a link out — which is a dead end
 * for the one thing the reader exists to do.
 *
 * So a refusal now falls through to reading the page. The probe that decides
 * framing already fetches it, so the article comes out of a response we were
 * downloading anyway, and the result is stored against the post: the first
 * reader pays for the fetch, everyone after them reads it out of the database,
 * and the publisher is asked once rather than once per view.
 *
 * @typedef {import('@rssamplifier/db').extracts.Extract} Extract
 */

/**
 * Decide how to show a post, fetching and extracting if it comes to that.
 *
 * Never throws. Every failure has the same shape as a refusal, because the
 * page's fallback — summary, link out, honest notice — is the right answer to
 * all of them and the reader should not see a stack trace because a publisher's
 * origin was down.
 *
 * @param {{ itemId: string, url: string|null }} post
 * @returns {Promise<{
 *   frameable: boolean,
 *   reason: string,
 *   article: { html: string, byline: string|null, siteName: string|null, length: number }|null,
 * }>}
 */
export async function readerView(post) {
  const { itemId, url } = post;
  if (!url) return { frameable: false, reason: 'no-url', article: null };

  const client = db();

  // Asked first, because a stored success means neither the probe nor the
  // fetch needs to happen at all — and a stored *failure* is what keeps a
  // paywalled post from being re-fetched on every view.
  const stored = await read(client, itemId);
  if (stored && !extracts.shouldFetch(stored)) {
    return {
      frameable: false,
      reason: stored.status === 'ok' ? 'extracted' : (stored.reason ?? stored.status),
      article: article(stored),
    };
  }

  // Everything past the cache is a network fetch and a DOM parse — the one
  // thing this app does that has to be bounded by *count* rather than by size,
  // and the thing that took the site down for eight hours on 2026-09-02.
  // Reasoning in lib/pageGate.js.
  return withPageSlot(
    () => fetchAndExtract(client, { itemId, url }),
    // Deliberately not written to the extract cache: a busy refusal is a fact
    // about this moment, not about the post. See pageGate.js.
    () => ({ frameable: false, reason: 'busy', article: null }),
  );
}

/**
 * Fetch the page and read it, having decided that is worth doing.
 *
 * Split out of `readerView` so the gate has a unit to wrap. The body is
 * unchanged and every early return keeps the meaning it had.
 *
 * @param {import('@libsql/client').Client} client
 * @param {{ itemId: string, url: string }} post
 * @returns {Promise<{
 *   frameable: boolean,
 *   reason: string,
 *   article: { html: string, byline: string|null, siteName: string|null, length: number }|null,
 * }>}
 */
async function fetchAndExtract(client, { itemId, url }) {
  const probe = await probePage(url, { origin: siteUrl() });

  // A stream is not a page, whatever its headers say it will allow.
  //
  // Icecast sends no X-Frame-Options and no framing policy, so the verdict on
  // a radio stream comes back "yes, frame me" — and the frame then loads an
  // endless mp3, which renders as nothing while it downloads forever. The
  // post looked broken and was not: the audio was playable the whole time,
  // sitting in the docked player behind an empty rectangle.
  //
  // Declining the frame is what hands the post to the player branch, where a
  // thing you listen to belongs. Deliberately not recorded as a failed
  // extract: nothing was attempted and nothing failed, and writing it down
  // would stop the post being looked at again if it ever becomes a page.
  if (isStream(probe.contentType)) {
    return { frameable: false, reason: 'stream', article: null };
  }

  if (probe.frameable) return { frameable: true, reason: probe.reason, article: null };

  // No body to read: the fetch failed, or the response was not HTML. Recorded
  // all the same, so the next reader of this post does not repeat it.
  if (!probe.html) {
    await remember(client, {
      itemId,
      url,
      status: probe.reason.startsWith('http-') || probe.reason === 'blocked-host' ? 'blocked' : 'error',
      reason: probe.reason,
    });
    return { frameable: false, reason: probe.reason, article: null };
  }

  const found = readableArticle(probe.html, probe.url ?? url);

  await remember(client, {
    itemId,
    url: probe.url ?? url,
    status: found ? 'ok' : 'empty',
    reason: found ? null : probe.reason,
    article: found,
  });

  return {
    frameable: false,
    // The reason the *frame* was refused still matters when there is no
    // article: it is what the page tells the reader. When there is one, the
    // refusal stopped mattering the moment we read the page ourselves.
    reason: found ? 'extracted' : probe.reason,
    article: found
      ? { html: found.html, byline: found.byline, siteName: found.siteName, length: found.length }
      : null,
  };
}

/**
 * @param {Extract|null} stored
 * @returns {{ html: string, byline: string|null, siteName: string|null, length: number }|null}
 */
function article(stored) {
  if (!stored || stored.status !== 'ok' || !stored.contentHtml) return null;
  return {
    html: stored.contentHtml,
    byline: stored.byline,
    siteName: stored.siteName,
    length: stored.length,
  };
}

/**
 * Whether a response is something to play rather than something to read.
 *
 * Audio and video only. A PDF or an image is also not an article, but both
 * render in a frame as themselves, so the frame is still the right answer for
 * them — this is about the types where the frame shows nothing at all.
 *
 * @param {string} contentType
 * @returns {boolean}
 */
function isStream(contentType) {
  const type = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return type.startsWith('audio/') || type.startsWith('video/');
}

/**
 * Reading the cache must never be the reason a page fails.
 *
 * @param {import('@libsql/client').Client} client
 * @param {string} itemId
 * @returns {Promise<Extract|null>}
 */
async function read(client, itemId) {
  try {
    return await extracts.forItem(client, itemId);
  } catch {
    return null;
  }
}

/**
 * Nor must writing it. A row we could not store costs the next reader a fetch;
 * an exception here would cost this one the whole page.
 *
 * @param {import('@libsql/client').Client} client
 * @param {Parameters<typeof extracts.save>[1]} result
 * @returns {Promise<void>}
 */
async function remember(client, result) {
  try {
    await extracts.save(client, result);
  } catch {
    /* best effort */
  }
}
