import { opmlFoot, opmlHead, opmlOutline } from '@rssamplifier/feed';
import {
  DISCLOSURES,
  checkRingMember,
  descriptorNamesRing,
  descriptorUrlFor,
  linksToRing,
  parseRingDescriptor,
  ringUrl,
  statusAfter,
} from '@rssamplifier/ingest';
import { webrings } from '@rssamplifier/db';

import { SCOPE_PROFILE_EDIT, SCOPE_RING_EDIT } from './openaccess.js';

/**
 * OpenWebring (logicsrc.com/openwebring), the host's half.
 *
 * A ring is an ordered circular list of member sites. This module holds
 * everything about one that can be decided without a database or a
 * network: how a hop finds the site the reader came from, which member it
 * sends them to, what the ring file and the host file look like, the OPML,
 * and the snippet a member pastes. The routes hand it rows and headers and
 * write out what it returns, so all of it is tested with neither.
 *
 * The verification half (does a member's page link back, what does its
 * descriptor say) is in @rssamplifier/ingest, because the poller runs it
 * too and cannot import this app. It is re-exported here so the web app
 * has one place to look.
 */

export {
  DISCLOSURES,
  checkRingMember,
  descriptorNamesRing,
  descriptorUrlFor,
  linksToRing,
  parseRingDescriptor,
  ringUrl,
  statusAfter,
};

/** The spec this host implements. */
export const SPEC = 'https://logicsrc.com/openwebring';

/** The version of it. */
export const VERSION = '0.1';

/** The hops a ring answers, with `prev` as the alias for `previous`. */
export const HOPS = ['next', 'previous', 'prev', 'random'];

/** The made_by values a member may declare. Absent is unstated. */
export const MADE_BY = webrings.MADE_BY;

/**
 * A site URL reduced to what identifies a member: host without `www.`,
 * path without a trailing slash, both lowercased, no scheme, no query.
 *
 * `?from=` arrives however the member wrote their own address, and the
 * Referer arrives however their server spelled it, so `http://www.Example.com/`
 * and `https://example.com` have to be the same site. A bare domain is
 * accepted and gets an empty path.
 *
 * @param {string|null|undefined} raw
 * @returns {{ host: string, path: string, key: string }|null}
 */
export function siteKey(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  // A scheme with no authority (mailto:, javascript:, data:) is not a site.
  // `host:port` looks like one and is not, so it is let through to the URL
  // parser with a scheme in front.
  if (/^[a-z][a-z0-9+.-]*:(?!\/\/)/i.test(s) && !/^[a-z0-9.-]+:\d+(?:\/|$)/i.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;

  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  const path = u.pathname.replace(/\/+$/, '').toLowerCase();
  return { host, path, key: `${host}${path}` };
}

/**
 * Where the reader came from, read off the request in the order the spec
 * ranks the shapes.
 *
 * A member slug in the path first, since it is unambiguous. Then the query,
 * `from` canonical and the three other spellings rings have used (Fediring's
 * `host`, webri.ng's `via`, openring-cf's `url`). Then the Referer, which is
 * what the IndieWeb ring runs on and what a member gets by pasting a link
 * with no parameter at all. Nothing found is null, and null means random.
 *
 * @param {{
 *   memberSlug?: string|null,
 *   params?: { get: (name: string) => string|null }|null,
 *   referer?: string|null,
 * }} [input]
 * @returns {{ slug: string }|{ url: string, via: 'from'|'host'|'via'|'url'|'referer' }|null}
 */
export function resolveFrom({ memberSlug = null, params = null, referer = null } = {}) {
  if (memberSlug && String(memberSlug).trim()) return { slug: String(memberSlug).trim().toLowerCase() };

  for (const name of /** @type {const} */ (['from', 'host', 'via', 'url'])) {
    const value = (params?.get(name) ?? '').trim();
    if (value) return { url: value, via: name };
  }

  const ref = (referer ?? '').trim();
  if (ref) return { url: ref, via: 'referer' };

  return null;
}

/**
 * The member a `from` names, or null.
 *
 * By slug when the path carried one. By URL otherwise: the exact site first,
 * then the member on that host whose path is the longest prefix of the page
 * the reader was on, since a Referer is usually a post and not a front page.
 * A bare domain matches the member whose site is on that host; if several
 * are, the one nearest the root.
 *
 * @template {{ member_slug: string, site_url: string }} M
 * @param {M[]} members
 * @param {{ slug?: string, url?: string }|null} from
 * @returns {M|null}
 */
export function findMember(members, from) {
  if (!from) return null;

  if ('slug' in from && from.slug) {
    const slug = from.slug.toLowerCase();
    return members.find((m) => m.member_slug.toLowerCase() === slug) ?? null;
  }

  const want = siteKey('url' in from ? from.url : null);
  if (!want) return null;

  /** @type {Array<{ member: M, path: string }>} */
  const onHost = [];
  for (const member of members) {
    const key = siteKey(member.site_url);
    if (!key || key.host !== want.host) continue;
    if (key.key === want.key) return member;
    onHost.push({ member, path: key.path });
  }
  if (onHost.length === 0) return null;

  if (want.path === '') {
    onHost.sort((a, b) => a.path.length - b.path.length);
    return onHost[0].member;
  }

  const under = onHost.filter((c) => c.path === '' || want.path.startsWith(`${c.path}/`));
  if (under.length === 0) return null;
  under.sort((a, b) => b.path.length - a.path.length);
  return under[0].member;
}

/**
 * Which member a hop lands on.
 *
 * Only active members are destinations; a pending or inactive member is in
 * the list, keeps its position, and is stepped over. `next` and `previous`
 * walk from the reader's position and wrap. An unknown or missing `from` is
 * a random active member, never an error: a hop that fails is a broken link
 * on somebody else's site. `random` never hands the reader back the site
 * they are on when there is anywhere else to go.
 *
 * Null only when no member is active at all, which the route turns into the
 * ring page.
 *
 * @template {{ member_slug: string, site_url: string, status: string }} M
 * @param {M[]} members in ring order
 * @param {string} kind next, previous, prev or random
 * @param {{ slug?: string, url?: string }|null} from
 * @param {() => number} [random]
 * @returns {M|null}
 */
export function hop(members, kind, from, random = Math.random) {
  const active = members.filter((m) => m.status === 'active');
  if (active.length === 0) return null;

  const pick = (/** @type {M[]} */ pool) => pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  const origin = findMember(members, from);

  if (kind === 'random') {
    const pool = origin && active.length > 1 ? active.filter((m) => m !== origin) : active;
    return pick(pool);
  }

  if (!origin) return pick(active);

  const n = members.length;
  const start = members.indexOf(origin);
  const step = kind === 'previous' || kind === 'prev' ? -1 : 1;
  for (let i = 1; i <= n; i += 1) {
    const candidate = members[(((start + step * i) % n) + n) % n];
    if (candidate.status === 'active') return candidate;
  }
  return null;
}

/**
 * A hop URL on this host.
 *
 * @param {string} base
 * @param {string} slug
 * @param {string} kind
 * @param {string|null} [from]
 * @returns {string}
 */
export function hopUrl(base, slug, kind, from = null) {
  const url = `${ringUrl(base, slug)}/${kind}`;
  return from ? `${url}?from=${encodeURIComponent(from)}` : url;
}

/**
 * One member as the ring file lists it.
 *
 * Absent means unstated: `made_by`, `disclosure`, `lang` and `checked` are
 * left out rather than written null, so a consumer cannot mistake "we do not
 * know" for "they said nothing".
 *
 * @param {import('@rssamplifier/db').webrings.RingMember} m
 * @returns {object}
 */
export function memberEntry(m) {
  return {
    url: m.site_url,
    slug: m.member_slug,
    name: m.title,
    feed: m.feed_url,
    ...(m.language ? { lang: m.language } : {}),
    ...(m.made_by ? { made_by: m.made_by } : {}),
    ...(m.disclosure ? { disclosure: m.disclosure } : {}),
    status: m.status,
    since: m.joined_at,
    ...(m.checked_at ? { checked: m.checked_at } : {}),
  };
}

/**
 * The ring file at /ring/<slug>/openwebring.json.
 *
 * @param {{ base: string, ring: import('@rssamplifier/db').webrings.Ring, members: import('@rssamplifier/db').webrings.RingMember[] }} input
 * @returns {object}
 */
export function ringFile({ base, ring, members }) {
  return {
    openwebring: VERSION,
    ring: {
      slug: ring.slug,
      name: ring.title,
      url: ringUrl(base, ring.slug),
      host: `${base}/`,
      ...(ring.description ? { description: ring.description } : {}),
      ...(ring.accepts ? { accepts: ring.accepts } : {}),
    },
    members: members.map(memberEntry),
    updated: ring.updated,
  };
}

/**
 * One ring as the host file lists it.
 *
 * @param {{ base: string, ring: import('@rssamplifier/db').webrings.Ring }} input
 * @returns {object}
 */
export function hostEntry({ base, ring }) {
  const url = ringUrl(base, ring.slug);
  return {
    slug: ring.slug,
    name: ring.title,
    url,
    ...(ring.description ? { description: ring.description } : {}),
    ...(ring.accepts ? { accepts: ring.accepts } : {}),
    join: `${url}#join`,
    members: ring.member_count,
    members_url: `${url}/openwebring.json`,
    opml: `${url}/opml`,
    updated: ring.updated,
  };
}

/**
 * The host file at /.well-known/openwebring.json.
 *
 * @param {{ base: string, siteName: string, rings: import('@rssamplifier/db').webrings.Ring[] }} input
 * @returns {object}
 */
export function hostFile({ base, siteName, rings }) {
  return {
    openwebring: VERSION,
    site: { url: `${base}/`, name: siteName },
    hosts: rings.map((ring) => hostEntry({ base, ring })),
    spec: SPEC,
  };
}

/**
 * The ring's feeds as OPML 2.0, in ring order.
 *
 * Every listed member, whatever its status: the OPML is a subscription
 * list, and a site that stopped linking to the ring did not stop
 * publishing. The ring file carries the status for anyone who wants to
 * filter on it.
 *
 * @param {{ ring: import('@rssamplifier/db').webrings.Ring, members: import('@rssamplifier/db').webrings.RingMember[] }} input
 * @returns {string}
 */
export function renderOpml({ ring, members }) {
  const outlines = members
    .filter((m) => m.feed_url)
    .map((m) => opmlOutline({ title: m.title, feed_url: m.feed_url, site_url: m.site_url }));
  return `${opmlHead(`${ring.title} webring`)}${outlines.join('\n')}${outlines.length ? '\n' : ''}${opmlFoot()}`;
}

/**
 * The three anchors a member pastes, with their own address in `from`.
 *
 * Exactly three plain links and nothing else: no script, no image, no rel
 * the spec did not register. The middle one is what the verification looks
 * for, and either hop counts too.
 *
 * @param {{ base: string, ring: { slug: string, title: string }, siteUrl?: string }} input
 * @returns {string}
 */
export function joinSnippet({ base, ring, siteUrl = 'https://example.com/' }) {
  const page = ringUrl(base, ring.slug);
  const from = encodeURIComponent(siteUrl);
  return [
    `<a href="${page}/previous?from=${from}">previous site</a>`,
    `<a href="${page}">${escapeHtml(ring.title)} webring</a>`,
    `<a href="${page}/next?from=${from}">next site</a>`,
  ].join('\n');
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Whether a caller may state who makes a member site, and as whom.
 *
 * Three ways in: an admin of the site; a holder of an OpenAccess grant for
 * `openwebring:edit`; or the person who claimed the profile of one of the
 * feed's authors, by account or by principal. The admin's word is recorded
 * as such; the other two are the owner's.
 *
 * @param {import('./profileAuth.js').Caller} caller
 * @param {{
 *   profiles: Array<import('@rssamplifier/db').profiles.AuthorProfile|null>,
 *   admins?: string[],
 * }} input
 * @returns {{ ok: true, source: 'owner'|'admin' } | { ok: false, status: number, error: string }}
 */
export function memberEditVerdict(caller, { profiles, admins = [] }) {
  if (!caller.kind) return { ok: false, status: 401, error: 'sign-in-required' };

  if (caller.email && admins.map((a) => a.toLowerCase()).includes(caller.email)) {
    return { ok: true, source: 'admin' };
  }

  if (caller.kind === 'openaccess' && caller.scopes.includes(SCOPE_RING_EDIT)) {
    return { ok: true, source: 'owner' };
  }

  for (const profile of profiles) {
    if (!profile || !profile.claimed_at) continue;
    if (caller.userId && caller.userId === profile.owner_user_id) return { ok: true, source: 'owner' };
    if (
      caller.kind === 'openaccess' &&
      caller.principal &&
      caller.principal === profile.owner_principal &&
      (caller.scopes.includes(SCOPE_PROFILE_EDIT) || caller.scopes.includes(SCOPE_RING_EDIT))
    ) {
      return { ok: true, source: 'owner' };
    }
  }

  return {
    ok: false,
    status: 403,
    error: `not the owner: claim the author profile of this feed, or hold an OpenAccess grant for ${SCOPE_RING_EDIT}`,
  };
}

/**
 * A made_by / disclosure patch, validated. Anything outside the vocabulary
 * is refused rather than mapped, and null clears.
 *
 * @param {any} body
 * @returns {{ ok: true, madeBy: string|null, disclosure: string|null } | { ok: false, error: string }}
 */
export function madeByPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'a JSON object is required' };
  if (!('made_by' in body)) return { ok: false, error: 'made_by is required: human, ai, both or null' };

  const madeBy = body.made_by;
  if (madeBy !== null && !MADE_BY.includes(madeBy)) {
    return { ok: false, error: `made_by must be one of ${MADE_BY.join(', ')}, or null` };
  }
  const disclosure = body.disclosure ?? null;
  if (disclosure !== null && !DISCLOSURES.includes(disclosure)) {
    return { ok: false, error: `disclosure must be one of ${DISCLOSURES.join(', ')}, or null` };
  }
  return { ok: true, madeBy, disclosure };
}

/**
 * How a made_by reads on a page.
 *
 * @param {string|null} madeBy
 * @returns {string|null}
 */
export function madeByLabel(madeBy) {
  switch (madeBy) {
    case 'human':
      return 'made by humans';
    case 'ai':
      return 'made by AI';
    case 'both':
      return 'made by humans and AI';
    default:
      return null;
  }
}
