import { webrings } from '@rssamplifier/db';
import { fetchPage, linksTo } from '@rssamplifier/feed';

/**
 * Verifying webring members (logicsrc.com/openwebring), the slow way.
 *
 * A member owes the ring one plain link. Whether it is there is a question
 * for a crawler, not for a request: the check is a fetch of a stranger's
 * front page plus one of their well-known file, and the reader who clicked
 * "next" is not the one who should wait for it. So this runs in the poller
 * beside the author enrichment, a bounded batch per tick, one site at a
 * time, and the hop routes read only what the last pass wrote.
 *
 * The verification model is the IndieWeb ring's: any link to the ring
 * counts, a site that stops linking is marked inactive and never removed,
 * and the check is repeated on a slow clock. On top of that the member's
 * descriptor at /.well-known/openwebring.json is read for two things the
 * spec adds: `made_by` (their own word on who makes the site, unverified
 * and recorded as such) and `rings[]`, the site's own statement of
 * membership, which counts as linking back.
 *
 * Pure where it can be. `checkRingMember` takes its fetch as an argument,
 * so the web app's on-demand check and this pass run the same decision, and
 * the tests run it with no network at all.
 */

/** How this pass names itself to the sites it reads. */
export const RING_USER_AGENT = 'rssamplifier-openwebring/1 (+https://rssamplifier.com/about)';

/** The W3C ai-disclosure vocabulary, verbatim. Anything else is dropped. */
export const DISCLOSURES = ['none', 'ai-assisted', 'ai-generated', 'autonomous'];

/**
 * A ring's page URL on this host.
 *
 * @param {string} base the site origin, no trailing slash
 * @param {string} slug
 * @returns {string}
 */
export function ringUrl(base, slug) {
  return `${String(base).replace(/\/+$/, '')}/ring/${encodeURIComponent(slug)}`;
}

/**
 * Every spelling of a link to the ring that a member might have written.
 *
 * The page URL over https, over http, and protocol-relative. Matched as a
 * prefix by `linksToRing`, so every hop URL under it counts too:
 * `/ring/x/next?from=...`, `/ring/x/<member>/random`, `/ring/x/opml`.
 *
 * @param {string} base
 * @param {string} slug
 * @returns {string[]}
 */
export function ringLinkTargets(base, slug) {
  const bare = ringUrl(base, slug).replace(/^https?:/, '');
  return [`https:${bare}`, `http:${bare}`, bare];
}

/**
 * Does this HTML link to the ring, in any of the shapes a member may use?
 *
 * @param {string|null|undefined} html
 * @param {string} base
 * @param {string} slug
 * @returns {boolean}
 */
export function linksToRing(html, base, slug) {
  if (!html) return false;
  return linksTo(html, ringLinkTargets(base, slug), { rels: null, prefix: true });
}

/**
 * The address of a site's own descriptor.
 *
 * At the origin, because that is where a well-known file lives; a member
 * whose site is a path on somebody else's host gets that host's descriptor,
 * which will not name them and does no harm.
 *
 * @param {string} siteUrl
 * @returns {string|null}
 */
export function descriptorUrlFor(siteUrl) {
  try {
    const u = new URL(siteUrl);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.origin}/.well-known/openwebring.json`;
  } catch {
    return null;
  }
}

/**
 * @typedef {{
 *   version: string|null,
 *   madeBy: 'human'|'ai'|'both'|null,
 *   disclosure: string|null,
 *   rings: Array<{ ring: string|null, slug: string|null }>,
 *   site: { url: string|null, name: string|null, feed: string|null, lang: string|null, banner: string|null }|null,
 * }} RingDescriptor
 */

/**
 * A member's descriptor, or null for anything that is not one.
 *
 * Strict about the shape and lenient about the rest: a page of HTML, a JSON
 * array, a string, a file whose `made_by` says "person" all come back as
 * null or as a descriptor with that field unstated. Nothing is inferred; a
 * value outside the vocabulary is the same as no value.
 *
 * @param {string|null|undefined} text
 * @returns {RingDescriptor|null}
 */
export function parseRingDescriptor(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const madeBy = webrings.MADE_BY.includes(data.made_by) ? data.made_by : null;
  const disclosure = DISCLOSURES.includes(data.disclosure) ? data.disclosure : null;

  const rings = Array.isArray(data.rings)
    ? data.rings
        .filter((r) => r && typeof r === 'object' && !Array.isArray(r))
        .map((r) => ({
          ring: typeof r.ring === 'string' ? r.ring.trim() : null,
          slug: typeof r.slug === 'string' ? r.slug.trim() : null,
        }))
        .filter((r) => r.ring || r.slug)
    : [];

  const site =
    data.site && typeof data.site === 'object' && !Array.isArray(data.site)
      ? {
          url: str(data.site.url),
          name: str(data.site.name),
          feed: str(data.site.feed),
          lang: str(data.site.lang),
          banner: str(data.site.banner),
        }
      : null;

  return {
    version: str(data.openwebring),
    madeBy,
    disclosure,
    rings,
    site,
  };
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Does the descriptor's `rings[]` name this ring?
 *
 * An entry names the ring by its URL: the page, or the ring file beside it,
 * over either scheme, with or without a trailing slash.
 *
 * @param {RingDescriptor|null} descriptor
 * @param {string} base
 * @param {string} slug
 * @returns {boolean}
 */
export function descriptorNamesRing(descriptor, base, slug) {
  if (!descriptor) return false;
  const page = ringUrl(base, slug).replace(/^https?:/, '').replace(/\/+$/, '').toLowerCase();
  for (const entry of descriptor.rings) {
    if (!entry.ring) continue;
    const named = entry.ring
      .replace(/^https?:/, '')
      .replace(/\/openwebring\.json$/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (named === page) return true;
  }
  return false;
}

/**
 * @typedef {{
 *   status: 'active'|'inactive',
 *   linked: 'page'|'descriptor'|null,
 *   reachable: boolean,
 *   madeBy: 'human'|'ai'|'both'|null,
 *   disclosure: string|null,
 *   descriptorUrl: string|null,
 * }} MemberCheck
 */

/**
 * Check one member: does its site link to the ring, and what does it say
 * about itself?
 *
 * Two fetches at most, the front page and the descriptor, through whatever
 * `fetchText` the caller hands in. A missing page and a page without the
 * link are the same answer, which is the honest one: the ring cannot tell
 * them apart and should not guess.
 *
 * @param {{
 *   base: string,
 *   ringSlug: string,
 *   memberUrl: string,
 *   fetchText: (url: string, opts?: { accept?: string }) => Promise<string|null>,
 * }} input
 * @returns {Promise<MemberCheck>}
 */
export async function checkRingMember({ base, ringSlug, memberUrl, fetchText }) {
  const html = await fetchText(memberUrl, { accept: 'text/html' }).catch(() => null);
  const linkedFromPage = linksToRing(html, base, ringSlug);

  const descriptorUrl = descriptorUrlFor(memberUrl);
  let descriptor = null;
  if (descriptorUrl) {
    const text = await fetchText(descriptorUrl, { accept: 'application/json' }).catch(() => null);
    descriptor = parseRingDescriptor(text);
  }
  const namedInDescriptor = descriptorNamesRing(descriptor, base, ringSlug);

  return {
    status: linkedFromPage || namedInDescriptor ? 'active' : 'inactive',
    linked: linkedFromPage ? 'page' : namedInDescriptor ? 'descriptor' : null,
    reachable: html != null,
    madeBy: descriptor?.madeBy ?? null,
    disclosure: descriptor?.disclosure ?? null,
    descriptorUrl: descriptor ? descriptorUrl : null,
  };
}

/**
 * What the pass records, given what the check found and what was there.
 *
 * An outage is not a departure. A site the pass could not reach at all
 * keeps its active status and gets a fresh stamp, so it is looked at again
 * next period rather than dropped from every hop for a week over one bad
 * minute. A site that answered without the link is inactive: that is the
 * fact the check exists to find.
 *
 * @param {MemberCheck} result
 * @param {string} current the member's status before the check
 * @returns {'active'|'inactive'}
 */
export function statusAfter(result, current) {
  if (result.status === 'active') return 'active';
  if (!result.reachable && current === 'active') return 'active';
  return 'inactive';
}

/**
 * The bounded fetch this pass uses, naming itself.
 *
 * @param {string} url
 * @param {{ accept?: string }} [opts]
 * @returns {Promise<string|null>}
 */
export function fetchRingPage(url, opts = {}) {
  return fetchPage(url, { userAgent: RING_USER_AGENT, accept: opts.accept ?? 'text/html' });
}

/**
 * One tick of verification: the members whose check is oldest, one at a
 * time, each recorded as soon as it is known.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{
 *   batch?: number,
 *   base: string,
 *   recheckDays?: number,
 *   fetchText?: typeof fetchRingPage,
 *   onEvent?: ((event: object) => void)|null,
 *   stopping?: () => boolean,
 * }} opts
 * @returns {Promise<{ checked: number, active: number, inactive: number, declared: number, unreachable: number }>}
 */
export async function verifyRingMembers(db, opts) {
  const batch = Math.max(1, Number(opts.batch ?? 25) || 25);
  const recheckDays = Math.max(0, Number(opts.recheckDays ?? 7) || 0);
  const fetchText = opts.fetchText ?? fetchRingPage;
  const before = recheckDays > 0 ? new Date(Date.now() - recheckDays * 86_400_000).toISOString() : null;

  const due = await webrings.membersDueForCheck(db, batch, { before });
  const tally = { checked: 0, active: 0, inactive: 0, declared: 0, unreachable: 0 };

  for (const member of due) {
    if (opts.stopping?.()) break;
    const result = await checkRingMember({
      base: opts.base,
      ringSlug: member.ring_slug,
      memberUrl: member.site_url,
      fetchText,
    });
    const status = statusAfter(result, member.status);
    await webrings.recordCheck(db, member.ring_slug, member.feed_id, {
      status,
      madeBy: result.madeBy,
      disclosure: result.disclosure,
      descriptorUrl: result.descriptorUrl,
    });
    tally.checked += 1;
    if (status === 'active') tally.active += 1;
    else tally.inactive += 1;
    if (result.madeBy) tally.declared += 1;
    if (!result.reachable) tally.unreachable += 1;
    opts.onEvent?.({
      event: 'ring-check',
      ring: member.ring_slug,
      member: member.member_slug,
      status,
      linked: result.linked,
      madeBy: result.madeBy,
      reachable: result.reachable,
    });
  }

  return tally;
}

/**
 * Seed or refresh the rings for the most covered topics.
 *
 * Idempotent: an existing ring keeps every member's position and gains
 * new feeds at the end (see `webrings.seedTopicRing`). A topic whose
 * eligible feeds fall under `minMembers` is skipped rather than made into
 * a ring of two, since a ring needs somewhere to hop to.
 *
 * A topic whose queries fail (the first production seed hit the request
 * deadline on the largest topic) is counted as failed and reported through
 * `onError`, and the pass goes on to the next one; one slow topic must not
 * cost every other ring its seed.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ topics?: number, minMembers?: number, limit?: number, onError?: ((topic: string, err: unknown) => void)|null }} [opts]
 * @returns {Promise<{ rings: number, created: number, added: number, skipped: number, failed: number }>}
 */
export async function seedTopRings(db, opts = {}) {
  const topics = Math.max(1, Number(opts.topics ?? 20) || 20);
  const minMembers = Math.max(1, Number(opts.minMembers ?? 5) || 5);
  const limit = Math.max(minMembers, Number(opts.limit ?? webrings.DEFAULT_RING_LIMIT) || webrings.DEFAULT_RING_LIMIT);

  // Twice as many candidates as rings wanted: the rollup counts every feed
  // on a topic, and a topic can be well covered by feeds that have no site
  // to link from or that the crawler has given up on.
  const candidates = await webrings.topRingTopics(db, { count: topics * 2, minFeeds: minMembers });
  const tally = { rings: 0, created: 0, added: 0, skipped: 0, failed: 0 };

  for (const topic of candidates) {
    if (tally.rings >= topics) break;
    try {
      const size = await webrings.topicRingSize(db, topic.slug, { cap: minMembers });
      if (size < minMembers) {
        tally.skipped += 1;
        continue;
      }
      const result = await webrings.seedTopicRing(db, topic.slug, { limit });
      tally.rings += 1;
      if (result.created) tally.created += 1;
      tally.added += result.added;
    } catch (err) {
      tally.failed += 1;
      opts.onError?.(topic.slug, err);
    }
  }

  return tally;
}
