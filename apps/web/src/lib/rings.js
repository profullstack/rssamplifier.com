import { authors, profiles, webrings } from '@rssamplifier/db';
import { RING_USER_AGENT } from '@rssamplifier/ingest';

import { db, siteUrl } from './db.js';
import { withPageSlot } from './pageGate.js';
import { fetchPage } from './profileAuth.js';
import { checkRingMember, hop, resolveFrom, ringUrl, statusAfter } from './openwebring.js';

/**
 * The database-backed half of the webring routes.
 *
 * Everything here reads or writes rows; everything it decides with is in
 * openwebring.js. The routes call one function each and return what it
 * hands back.
 */

/** How long a loaded ring is reused by this worker before it is read again. */
const RING_TTL_MS = 30_000;

/** @type {Map<string, { at: number, value: { ring: import('@rssamplifier/db').webrings.Ring, members: import('@rssamplifier/db').webrings.RingMember[] }|null }>} */
const loaded = new Map();

/**
 * A ring and its members, from a short per-worker cache.
 *
 * A hop is one indexed read of a list that is at most a few hundred rows
 * and changes when the verification pass runs, which is on a clock of
 * minutes. Thirty seconds of reuse turns a busy ring into no database
 * traffic at all, which matters because hops are exempt from the throttle
 * (proxy.js) and the throttle was the only thing between a stranger's loop
 * and the connection limit.
 *
 * @param {string} slug
 * @returns {Promise<{ ring: import('@rssamplifier/db').webrings.Ring, members: import('@rssamplifier/db').webrings.RingMember[] }|null>}
 */
export async function loadRing(slug) {
  const key = slug.toLowerCase();
  const hit = loaded.get(key);
  if (hit && Date.now() - hit.at < RING_TTL_MS) return hit.value;

  const client = db();
  const ring = await webrings.ringBySlug(client, key);
  const value = ring && ring.public ? { ring, members: await webrings.membersOf(client, key) } : null;

  if (loaded.size > 1000) loaded.clear();
  loaded.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Drop a ring from this worker's cache after a write.
 *
 * @param {string} slug
 * @returns {void}
 */
export function forgetRing(slug) {
  loaded.delete(slug.toLowerCase());
}

/**
 * Answer a hop: 302 to the member, no cookie, no write.
 *
 * `cache-control: no-store`, because the answer depends on the Referer and
 * on a coin, and a cached 302 would pin every reader of a member's page to
 * one neighbour. An unknown ring is a 404 in plain text; a ring with nobody
 * active sends the reader to the ring's own page rather than nowhere.
 *
 * @param {Request} req
 * @param {{ slug: string, memberSlug?: string|null, kind: 'next'|'previous'|'prev'|'random' }} input
 * @returns {Promise<Response>}
 */
export async function hopResponse(req, { slug, memberSlug = null, kind }) {
  const ring = await loadRing(slug);
  if (!ring) {
    return new Response('no such ring\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const url = new URL(req.url);
  const from = resolveFrom({ memberSlug, params: url.searchParams, referer: req.headers.get('referer') });
  const target = hop(ring.members, kind, from);

  return new Response(null, {
    status: 302,
    headers: {
      location: target ? target.site_url : ringUrl(siteUrl(), ring.ring.slug),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * Check one member now, behind the page gate, and record what was found.
 *
 * The same decision the poller makes, run on demand for a member who has
 * just pasted the snippet and does not want to wait a week. The gate is
 * the reader's: a fetch of a stranger's page is the most expensive thing
 * this process does, and lib/pageGate.js explains what happened when
 * nothing bounded how many ran at once. Null means the gate was full.
 *
 * @param {{ ring: import('@rssamplifier/db').webrings.Ring, members: import('@rssamplifier/db').webrings.RingMember[] }} ring
 * @param {import('@rssamplifier/db').webrings.RingMember} member
 * @returns {Promise<{ status: string, result: any }|null>}
 */
export async function checkMemberNow(ring, member) {
  const base = siteUrl();
  const result = await withPageSlot(
    () =>
      checkRingMember({
        base,
        ringSlug: ring.ring.slug,
        memberUrl: member.site_url,
        fetchText: (url, opts) => fetchPage(url, { userAgent: RING_USER_AGENT, ...(opts ?? {}) }),
      }),
    () => null,
  );
  if (!result) return null;

  const status = statusAfter(result, member.status);
  await webrings.recordCheck(db(), ring.ring.slug, member.feed_id, {
    status,
    madeBy: result.madeBy,
    disclosure: result.disclosure,
    descriptorUrl: result.descriptorUrl,
  });
  forgetRing(ring.ring.slug);
  return { status, result };
}

/**
 * The claimed profiles of everyone credited on a feed, for the owner check.
 *
 * @param {string} feedId
 * @returns {Promise<Array<import('@rssamplifier/db').profiles.AuthorProfile|null>>}
 */
export async function profilesForFeed(feedId) {
  const client = db();
  const credited = await authors.authorsForFeed(client, feedId);
  return Promise.all(credited.map((person) => profiles.profileForAuthor(client, String(person.id))));
}
