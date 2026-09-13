import { RING_USER_AGENT } from '@rssamplifier/ingest';

import { withPageSlot } from './pageGate.js';

const TTL_MS = 6 * 60 * 60 * 1000;

/** @type {Map<string, { at: number, value: { ok: boolean, reason: string } }>} */
const seen = new Map();

/**
 * Whether a site lets this host put it in an iframe.
 *
 * A site that refuses says so in its response headers, and a browser that
 * obeys them paints nothing and tells the page nothing: from the outside a
 * refused frame and a slow one look the same. So the viewer asks first, with
 * one request that reads the headers and drops the body, and shows a card
 * with a link instead of an empty frame. The answer is kept for six hours per
 * URL; a site changes this setting about never.
 *
 * Any failure to ask (a timeout, a site that is down, the fetch gate full) is
 * "let the frame try": the cost of a wrong yes is one blank frame with the
 * open-in-a-new-tab button right above it, the cost of a wrong no is hiding a
 * site that would have shown.
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
export async function frameable(url) {
  const hit = seen.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const value = await withPageSlot(
    () => probe(url),
    () => ({ ok: true, reason: 'gate busy' }),
  );

  if (seen.size > 5000) seen.clear();
  seen.set(url, { at: Date.now(), value });
  return value;
}

/**
 * @param {string} url
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
async function probe(url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
      headers: { 'user-agent': RING_USER_AGENT, accept: 'text/html' },
    });
  } catch {
    return { ok: true, reason: 'unreachable' };
  }
  // The headers are the whole answer; the page itself is the frame's to load.
  res.body?.cancel().catch(() => {});

  const xfo = (res.headers.get('x-frame-options') ?? '').trim().toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return { ok: false, reason: `x-frame-options ${xfo}` };

  const ancestors = (res.headers.get('content-security-policy') ?? '')
    .split(';')
    .map((d) => d.trim().toLowerCase())
    .find((d) => d.startsWith('frame-ancestors'));
  if (ancestors) {
    const allowed = ancestors.split(/\s+/).slice(1);
    const us = allowed.some((a) => a === '*' || a === 'https:' || a.includes('rssamplifier.com'));
    if (!us) return { ok: false, reason: 'frame-ancestors' };
  }

  return { ok: true, reason: '' };
}
