import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkRingMember,
  descriptorNamesRing,
  descriptorUrlFor,
  findMember,
  hop,
  hopUrl,
  hostFile,
  joinSnippet,
  linksToRing,
  madeByPatch,
  memberEditVerdict,
  memberEntry,
  parseRingDescriptor,
  renderOpml,
  resolveFrom,
  ringFile,
  siteKey,
  statusAfter,
} from '../src/lib/openwebring.js';
import { linksBack } from '../src/lib/profileAuth.js';

/**
 * OpenWebring, the host's half, with no database and no network.
 *
 * A ring is an ordered circular list; the tests are about the order, about
 * finding the site a reader came from however it was spelled, about what a
 * hop skips, and about what counts as a member linking back.
 */

const BASE = 'https://rssamplifier.test';

/**
 * A ring of five, in order, with one pending and one inactive.
 *
 * @param {Partial<{ status: string[] }>} [opts]
 */
function members(opts = {}) {
  const status = opts.status ?? ['active', 'active', 'pending', 'active', 'inactive'];
  return [
    { member_slug: 'alpha', site_url: 'https://alpha.example/', title: 'Alpha', feed_url: 'https://alpha.example/feed', language: 'en', made_by: 'human', disclosure: null, checked_at: '2026-09-10T00:00:00.000Z', joined_at: '2026-09-01T00:00:00.000Z' },
    { member_slug: 'beta', site_url: 'http://www.Beta.example/blog', title: 'Beta', feed_url: 'https://beta.example/blog/rss', language: null, made_by: null, disclosure: null, checked_at: null, joined_at: '2026-09-01T00:00:00.000Z' },
    { member_slug: 'gamma', site_url: 'https://gamma.example', title: 'Gamma', feed_url: 'https://gamma.example/atom', language: 'de', made_by: 'ai', disclosure: 'ai-generated', checked_at: null, joined_at: '2026-09-02T00:00:00.000Z' },
    { member_slug: 'delta', site_url: 'https://pages.example/delta/', title: 'Delta', feed_url: 'https://pages.example/delta/feed', language: null, made_by: 'both', disclosure: null, checked_at: '2026-09-11T00:00:00.000Z', joined_at: '2026-09-03T00:00:00.000Z' },
    { member_slug: 'epsilon', site_url: 'https://pages.example/epsilon', title: 'Epsilon', feed_url: 'https://pages.example/epsilon/feed', language: null, made_by: null, disclosure: null, checked_at: '2026-09-11T00:00:00.000Z', joined_at: '2026-09-04T00:00:00.000Z' },
  ].map((m, i) => ({ ...m, ring_slug: 'physics', feed_id: `f${i}`, position: i, status: status[i], made_by_source: m.made_by ? 'descriptor' : null, descriptor_url: null }));
}

const RING = {
  slug: 'physics',
  title: 'Physics',
  description: 'Sites in the directory filed under Physics.',
  kind: 'topic',
  topic_slug: 'physics',
  accepts: null,
  public: true,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  member_count: 5,
  active_count: 3,
  updated: '2026-09-11T00:00:00.000Z',
};

/** A query-string stand-in. @param {Record<string, string>} q */
const params = (q) => ({ get: (k) => q[k] ?? null });

test('a site URL is reduced to what identifies it', () => {
  // Scheme, case, www and the trailing slash are how the same site gets
  // spelled four ways; none of them is a different member.
  assert.equal(siteKey('https://www.Example.com/').key, 'example.com');
  assert.equal(siteKey('http://example.com').key, 'example.com');
  assert.equal(siteKey('example.com').key, 'example.com', 'a bare domain is accepted');
  assert.equal(siteKey('//example.com/blog/').key, 'example.com/blog', 'protocol-relative too');
  assert.equal(siteKey('https://example.com/Blog/?utm=x#top').key, 'example.com/blog', 'query and fragment are not identity');
  assert.equal(siteKey('mailto:a@b.c'), null);
  assert.equal(siteKey(''), null);
  assert.equal(siteKey(null), null);
});

test('from is read off the request in the order the spec ranks the shapes', () => {
  assert.deepEqual(resolveFrom({ memberSlug: 'Alpha', params: params({ from: 'https://x' }) }), { slug: 'alpha' }, 'a slug in the path wins');
  assert.deepEqual(resolveFrom({ params: params({ from: 'https://a.example/' }) }), { url: 'https://a.example/', via: 'from' });
  assert.deepEqual(resolveFrom({ params: params({ host: 'a.example' }) }), { url: 'a.example', via: 'host' }, 'Fediring');
  assert.deepEqual(resolveFrom({ params: params({ via: 'https://a.example/' }) }), { url: 'https://a.example/', via: 'via' }, 'webri.ng');
  assert.deepEqual(resolveFrom({ params: params({ url: 'a.example' }) }), { url: 'a.example', via: 'url' }, 'openring-cf');
  assert.deepEqual(
    resolveFrom({ params: params({ from: ' ' }), referer: 'https://a.example/posts/1' }),
    { url: 'https://a.example/posts/1', via: 'referer' },
    'an empty from falls through to the Referer',
  );
  assert.equal(resolveFrom({ params: params({}), referer: '' }), null, 'nothing is nothing');
  assert.equal(resolveFrom(), null);
});

test('a member is found however the reader spelled where they came from', () => {
  const ring = members();
  assert.equal(findMember(ring, { slug: 'GAMMA' })?.member_slug, 'gamma');
  assert.equal(findMember(ring, { slug: 'nobody' }), null);

  assert.equal(findMember(ring, { url: 'https://alpha.example' })?.member_slug, 'alpha', 'trailing slash');
  assert.equal(findMember(ring, { url: 'http://ALPHA.example/' })?.member_slug, 'alpha', 'scheme and case');
  assert.equal(findMember(ring, { url: 'https://www.alpha.example/' })?.member_slug, 'alpha', 'www');
  assert.equal(findMember(ring, { url: 'https://beta.example/blog/' })?.member_slug, 'beta', 'the member had www and http');
  assert.equal(findMember(ring, { url: 'alpha.example' })?.member_slug, 'alpha', 'a bare domain matches the member on that host');
  assert.equal(findMember(ring, { url: 'beta.example' })?.member_slug, 'beta', 'even when the member lives on a path');

  // A Referer is usually a post, not the front page.
  assert.equal(findMember(ring, { url: 'https://alpha.example/posts/2026/hello' })?.member_slug, 'alpha');
  assert.equal(findMember(ring, { url: 'https://pages.example/delta/posts/1' })?.member_slug, 'delta', 'two members on one host, by path');
  assert.equal(findMember(ring, { url: 'https://pages.example/epsilon/about' })?.member_slug, 'epsilon');
  assert.equal(findMember(ring, { url: 'https://pages.example/zeta/' }), null, 'a path nobody owns on a shared host is nobody');
  assert.equal(findMember(ring, { url: 'https://pages.example/deltoid' }), null, 'a prefix of letters is not a prefix of paths');
  assert.equal(findMember(ring, { url: 'https://elsewhere.example/' }), null);
  assert.equal(findMember(ring, null), null);
});

test('next and previous walk the ring in order and wrap around', () => {
  const ring = members();
  assert.equal(hop(ring, 'next', { slug: 'alpha' })?.member_slug, 'beta');
  assert.equal(hop(ring, 'next', { slug: 'beta' })?.member_slug, 'delta', 'gamma is pending and skipped');
  assert.equal(hop(ring, 'next', { slug: 'delta' })?.member_slug, 'alpha', 'epsilon is inactive, then it wraps');
  assert.equal(hop(ring, 'previous', { slug: 'alpha' })?.member_slug, 'delta', 'backwards wraps past the inactive one');
  assert.equal(hop(ring, 'prev', { slug: 'delta' })?.member_slug, 'beta', 'prev is previous');
  assert.equal(hop(ring, 'previous', { url: 'https://beta.example/blog/x' })?.member_slug, 'alpha');
});

test('a hop from a listed but inactive member still lands somewhere sensible', () => {
  // A pending member has a position and a page; a reader who clicked next on
  // it should get the site after it, not a random one.
  const ring = members();
  assert.equal(hop(ring, 'next', { slug: 'gamma' })?.member_slug, 'delta');
  assert.equal(hop(ring, 'previous', { slug: 'gamma' })?.member_slug, 'beta');
  assert.equal(hop(ring, 'next', { slug: 'epsilon' })?.member_slug, 'alpha');
});

test('an unknown or missing from is a random active member, never an error', () => {
  const ring = members();
  const seen = new Set();
  let i = 0;
  const random = () => [0, 0.5, 0.99][i++ % 3];
  for (let k = 0; k < 3; k += 1) seen.add(hop(ring, 'next', { url: 'https://stranger.example/' }, random)?.member_slug);
  assert.deepEqual([...seen].sort(), ['alpha', 'beta', 'delta'], 'only active members, and any of them');
  assert.ok(hop(ring, 'previous', null));
  assert.equal(hop(members({ status: ['pending', 'inactive', 'pending', 'inactive', 'pending'] }), 'next', null), null, 'nobody active is null, which the route turns into the ring page');
});

test('random never hands the reader back the site they are on', () => {
  const ring = members();
  for (let k = 0; k < 40; k += 1) {
    const landed = hop(ring, 'random', { slug: 'alpha' });
    assert.ok(landed && landed.member_slug !== 'alpha' && landed.status === 'active');
  }
  const alone = members({ status: ['active', 'inactive', 'inactive', 'inactive', 'inactive'] });
  assert.equal(hop(alone, 'random', { slug: 'alpha' })?.member_slug, 'alpha', 'unless there is nowhere else to go');
  assert.equal(hop(alone, 'next', { slug: 'alpha' })?.member_slug, 'alpha', 'and next wraps to itself');
});

test('a hop URL carries the reader\'s address when there is one', () => {
  assert.equal(hopUrl(BASE, 'physics', 'next'), `${BASE}/ring/physics/next`);
  assert.equal(hopUrl(BASE, 'physics', 'random', 'https://a.example/?x=1'), `${BASE}/ring/physics/random?from=https%3A%2F%2Fa.example%2F%3Fx%3D1`);
});

test('a link to the ring counts in every shape a member might write it', () => {
  const page = `${BASE}/ring/physics`;
  const shapes = [
    `<a href="${page}">ring</a>`,
    `<a href="${page}/">ring</a>`,
    `<a href="${page.replace('https:', 'http:')}">ring</a>`,
    `<a href="${page.replace('https:', '')}">ring</a>`,
    `<a class="x" href='${page}/next?from=https://alpha.example/'>next</a>`,
    `<a href=${page}/previous?from=https%3A%2F%2Falpha.example%2F>prev</a>`,
    `<a href="${page}/prev?from=alpha.example">prev</a>`,
    `<a href="${page}/random">random</a>`,
    `<a href="${page}/alpha/next">next</a>`,
    `<a href="${page}/alpha/random">random</a>`,
    `<a href="${page}/next?from=https://alpha.example/&amp;x=1">next</a>`,
    `<a href="${page.toUpperCase()}">ring</a>`,
    `<link rel="openwebring" href="${page}/openwebring.json">`,
    `<A HREF="${page}#join">join</A>`,
    `<a rel="nofollow" target="_blank" href="${page}/opml">opml</a>`,
  ];
  for (const html of shapes) {
    assert.ok(linksToRing(`<html><body><p>hi</p>${html}</body></html>`, BASE, 'physics'), html);
  }

  const not = [
    `<a href="${BASE}/ring/physics-2">other ring</a>`,
    `<a href="${BASE}/ring/chemistry/next">other ring</a>`,
    `<a href="${BASE}/ring">index</a>`,
    `<a href="${BASE}/">the directory</a>`,
    `<a href="https://other.example/ring/physics">another host</a>`,
    `<p>${page}</p>`,
    `<img src="${page}">`,
  ];
  for (const html of not) {
    assert.ok(!linksToRing(html, BASE, 'physics'), html);
  }
  assert.ok(!linksToRing(null, BASE, 'physics'));
  assert.ok(!linksToRing('', BASE, 'physics'));
});

test('the OpenProfile claim check reads as it did', () => {
  // linksBack was generalised, not changed: it still wants rel="openprofile"
  // or rel="me" on an exact link, whatever the attribute order.
  const url = `${BASE}/authors/ada/openprofile.md`;
  assert.ok(linksBack(`<link href="${url}" rel="openprofile">`, [url]));
  assert.ok(linksBack(`<a rel="me nofollow" href="${url}/">me</a>`, [url]));
  assert.ok(!linksBack(`<a href="${url}">no rel</a>`, [url]), 'a plain link is not a claim');
  assert.ok(!linksBack(`<a rel="openprofile" href="${url}/extra">deeper</a>`, [url]), 'and it is exact');
  assert.ok(!linksBack(`<a rel="home" href="${url}">home</a>`, [url]), '"me" inside another token is not "me"');
});

test('a descriptor is read strictly and junk is nothing', () => {
  const d = parseRingDescriptor(JSON.stringify({
    openwebring: '0.1',
    site: { url: 'https://alpha.example/', name: 'Alpha', feed: 'https://alpha.example/feed', lang: 'en' },
    made_by: 'human',
    disclosure: 'none',
    rings: [{ ring: `${BASE}/ring/physics`, slug: 'alpha' }, 'junk', { slug: 7 }, null],
  }));
  assert.ok(d);
  assert.equal(d.madeBy, 'human');
  assert.equal(d.disclosure, 'none');
  assert.equal(d.site?.name, 'Alpha');
  assert.deepEqual(d.rings, [{ ring: `${BASE}/ring/physics`, slug: 'alpha' }]);

  assert.equal(parseRingDescriptor('<!doctype html><html>a 404 page</html>'), null, 'HTML is not a descriptor');
  assert.equal(parseRingDescriptor('[]'), null);
  assert.equal(parseRingDescriptor('"human"'), null);
  assert.equal(parseRingDescriptor('{not json'), null);
  assert.equal(parseRingDescriptor(null), null);
  assert.equal(parseRingDescriptor(''), null);

  const loose = parseRingDescriptor('{"made_by":"person","disclosure":"some","rings":"x"}');
  assert.ok(loose, 'an object is a descriptor even when every field is off');
  assert.equal(loose.madeBy, null, 'a value outside the vocabulary is unstated, never mapped');
  assert.equal(loose.disclosure, null);
  assert.deepEqual(loose.rings, []);
});

test('a descriptor naming the ring counts as linking back', () => {
  const named = (ring) => descriptorNamesRing(parseRingDescriptor(JSON.stringify({ rings: [{ ring, slug: 'alpha' }] })), BASE, 'physics');
  assert.ok(named(`${BASE}/ring/physics`));
  assert.ok(named(`${BASE}/ring/physics/`));
  assert.ok(named(`${BASE.replace('https:', 'http:')}/ring/physics`));
  assert.ok(named(`${BASE}/ring/physics/openwebring.json`), 'the ring file is the ring');
  assert.ok(!named(`${BASE}/ring/chemistry`));
  assert.ok(!named('https://other.example/ring/physics'));
  assert.ok(!descriptorNamesRing(null, BASE, 'physics'));
  assert.equal(descriptorUrlFor('https://alpha.example/blog/'), 'https://alpha.example/.well-known/openwebring.json', 'at the origin');
  assert.equal(descriptorUrlFor('not a url'), null);
});

test('checking a member asks two URLs and decides from both', async () => {
  const page = `<a href="${BASE}/ring/physics/next?from=https://alpha.example/">next</a>`;
  const descriptor = JSON.stringify({ made_by: 'both', disclosure: 'ai-assisted', rings: [] });

  /** @param {Record<string, string|null>} answers */
  const fetching = (answers) => {
    const asked = [];
    const fetchText = async (url, opts) => {
      asked.push(`${opts?.accept ?? ''} ${url}`);
      return answers[url] ?? null;
    };
    return { asked, fetchText };
  };

  const linked = fetching({ 'https://alpha.example/': page, 'https://alpha.example/.well-known/openwebring.json': descriptor });
  const a = await checkRingMember({ base: BASE, ringSlug: 'physics', memberUrl: 'https://alpha.example/', fetchText: linked.fetchText });
  assert.deepEqual(a, { status: 'active', linked: 'page', reachable: true, madeBy: 'both', disclosure: 'ai-assisted', descriptorUrl: 'https://alpha.example/.well-known/openwebring.json' });
  assert.deepEqual(linked.asked, ['text/html https://alpha.example/', 'application/json https://alpha.example/.well-known/openwebring.json']);

  const byDescriptor = fetching({
    'https://alpha.example/': '<p>no link here</p>',
    'https://alpha.example/.well-known/openwebring.json': JSON.stringify({ made_by: 'human', rings: [{ ring: `${BASE}/ring/physics`, slug: 'alpha' }] }),
  });
  const b = await checkRingMember({ base: BASE, ringSlug: 'physics', memberUrl: 'https://alpha.example/', fetchText: byDescriptor.fetchText });
  assert.equal(b.status, 'active');
  assert.equal(b.linked, 'descriptor');
  assert.equal(b.madeBy, 'human');

  const nothing = fetching({ 'https://alpha.example/': '<p>gone quiet</p>' });
  const c = await checkRingMember({ base: BASE, ringSlug: 'physics', memberUrl: 'https://alpha.example/', fetchText: nothing.fetchText });
  assert.equal(c.status, 'inactive');
  assert.equal(c.linked, null);
  assert.equal(c.madeBy, null, 'a 404 descriptor says nothing');
  assert.equal(c.descriptorUrl, null);

  const down = fetching({});
  const d = await checkRingMember({ base: BASE, ringSlug: 'physics', memberUrl: 'https://alpha.example/', fetchText: down.fetchText });
  assert.equal(d.reachable, false);
  assert.equal(statusAfter(d, 'active'), 'active', 'an outage is not a departure');
  assert.equal(statusAfter(d, 'pending'), 'inactive', 'but a site that has never answered is not active either');
  assert.equal(statusAfter(c, 'active'), 'inactive', 'a page that answered without the link is');

  const throwing = async () => { throw new Error('boom'); };
  const e = await checkRingMember({ base: BASE, ringSlug: 'physics', memberUrl: 'https://alpha.example/', fetchText: throwing });
  assert.equal(e.status, 'inactive', 'a fetch that throws is a fetch that found nothing');
});

test('the ring file lists members in order and leaves the unstated absent', () => {
  const file = ringFile({ base: BASE, ring: RING, members: members() });
  assert.equal(file.openwebring, '0.1');
  assert.deepEqual(file.ring, {
    slug: 'physics',
    name: 'Physics',
    url: `${BASE}/ring/physics`,
    host: `${BASE}/`,
    description: 'Sites in the directory filed under Physics.',
  });
  assert.ok(!('accepts' in file.ring), 'a topic ring accepts everybody, said by saying nothing');
  assert.deepEqual(file.members.map((m) => m.slug), ['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
  assert.deepEqual(file.members[0], {
    url: 'https://alpha.example/',
    slug: 'alpha',
    name: 'Alpha',
    feed: 'https://alpha.example/feed',
    lang: 'en',
    made_by: 'human',
    status: 'active',
    since: '2026-09-01T00:00:00.000Z',
    checked: '2026-09-10T00:00:00.000Z',
  });
  const beta = file.members[1];
  assert.ok(!('made_by' in beta) && !('lang' in beta) && !('checked' in beta) && !('disclosure' in beta), 'nothing null is written');
  assert.equal(file.members[2].disclosure, 'ai-generated');
  assert.equal(file.updated, RING.updated);
});

test('the host file names every ring with where its pieces are', () => {
  const file = hostFile({ base: BASE, siteName: 'RSS Amplifier', rings: [RING, { ...RING, slug: 'jazz', title: 'Jazz', accepts: ['human', 'both'], description: null }] });
  assert.equal(file.openwebring, '0.1');
  assert.deepEqual(file.site, { url: `${BASE}/`, name: 'RSS Amplifier' });
  assert.equal(file.spec, 'https://logicsrc.com/openwebring');
  assert.deepEqual(file.hosts[0], {
    slug: 'physics',
    name: 'Physics',
    url: `${BASE}/ring/physics`,
    description: 'Sites in the directory filed under Physics.',
    join: `${BASE}/ring/physics#join`,
    members: 5,
    members_url: `${BASE}/ring/physics/openwebring.json`,
    opml: `${BASE}/ring/physics/opml`,
    updated: RING.updated,
  });
  assert.deepEqual(file.hosts[1].accepts, ['human', 'both']);
  assert.ok(!('description' in file.hosts[1]));
});

test('the OPML is the members\' feeds in ring order', () => {
  const opml = renderOpml({ ring: RING, members: members() });
  assert.match(opml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<opml version="2.0">/);
  assert.match(opml, /<title>Physics webring<\/title>/);
  const outlines = opml.match(/<outline [^>]*\/>/g) ?? [];
  assert.equal(outlines.length, 5, 'every listed member, whatever its status');
  assert.match(outlines[0], /text="Alpha"/);
  assert.match(outlines[0], /title="Alpha"/);
  assert.match(outlines[0], /type="rss"/);
  assert.match(outlines[0], /xmlUrl="https:\/\/alpha.example\/feed"/);
  assert.match(outlines[0], /htmlUrl="https:\/\/alpha.example\/"/);
  assert.match(outlines[1], /xmlUrl="https:\/\/beta.example\/blog\/rss"/);
  assert.match(opml, /<\/body>\n<\/opml>\n$/);
  assert.equal((renderOpml({ ring: RING, members: [] }).match(/<outline/g) ?? []).length, 0);
});

test('the join snippet is three plain anchors and nothing else', () => {
  const snippet = joinSnippet({ base: BASE, ring: RING, siteUrl: 'https://alpha.example/' });
  const lines = snippet.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `<a href="${BASE}/ring/physics/previous?from=https%3A%2F%2Falpha.example%2F">previous site</a>`);
  assert.equal(lines[1], `<a href="${BASE}/ring/physics">Physics webring</a>`);
  assert.equal(lines[2], `<a href="${BASE}/ring/physics/next?from=https%3A%2F%2Falpha.example%2F">next site</a>`);
  assert.ok(!/script|img|rel=/.test(snippet));
  assert.ok(linksToRing(snippet, BASE, 'physics'), 'and the verification accepts its own snippet');
  assert.match(joinSnippet({ base: BASE, ring: { slug: 'x', title: 'A & B <c>' } }), /A &amp; B &lt;c&gt; webring/);
});

test('who may state who makes a site', () => {
  const none = { kind: null, userId: null, email: null, principal: null, scopes: [] };
  const claimedByUser = { author_id: 'a', claimed_at: 'now', owner_user_id: 'u1', owner_principal: null };
  const claimedByPrincipal = { author_id: 'b', claimed_at: 'now', owner_user_id: null, owner_principal: 'did:x' };
  const unclaimed = { author_id: 'c', claimed_at: null, owner_user_id: 'u1', owner_principal: null };

  assert.deepEqual(memberEditVerdict(none, { profiles: [claimedByUser] }), { ok: false, status: 401, error: 'sign-in-required' });

  const session = { ...none, kind: 'session', userId: 'u1', email: 'ada@example.com' };
  assert.deepEqual(memberEditVerdict(session, { profiles: [claimedByUser] }), { ok: true, source: 'owner' });
  assert.equal(memberEditVerdict({ ...session, userId: 'u2' }, { profiles: [claimedByUser] }).ok, false, 'somebody else');
  assert.equal(memberEditVerdict(session, { profiles: [unclaimed] }).ok, false, 'an unclaimed profile owns nothing');
  assert.equal(memberEditVerdict(session, { profiles: [null] }).ok, false);
  assert.deepEqual(memberEditVerdict({ ...session, userId: 'u9' }, { profiles: [], admins: ['Ada@example.com'] }), { ok: true, source: 'admin' });

  const principal = { ...none, kind: 'openaccess', principal: 'did:x', scopes: ['openprofile:edit'] };
  assert.deepEqual(memberEditVerdict(principal, { profiles: [claimedByPrincipal] }), { ok: true, source: 'owner' }, 'the principal who claimed it, with the profile scope');
  assert.equal(memberEditVerdict({ ...principal, scopes: [] }, { profiles: [claimedByPrincipal] }).ok, false, 'a grant with no scope');
  assert.deepEqual(
    memberEditVerdict({ ...principal, principal: 'did:other', scopes: ['openwebring:edit'] }, { profiles: [claimedByPrincipal] }),
    { ok: true, source: 'owner' },
    'the ring scope on its own, as the descriptor says',
  );
});

test('a made_by patch is validated, not mapped', () => {
  assert.deepEqual(madeByPatch({ made_by: 'human' }), { ok: true, madeBy: 'human', disclosure: null });
  assert.deepEqual(madeByPatch({ made_by: 'ai', disclosure: 'ai-generated' }), { ok: true, madeBy: 'ai', disclosure: 'ai-generated' });
  assert.deepEqual(madeByPatch({ made_by: null }), { ok: true, madeBy: null, disclosure: null }, 'null clears');
  assert.equal(madeByPatch({ made_by: 'person' }).ok, false);
  assert.equal(madeByPatch({ made_by: 'human', disclosure: 'some' }).ok, false);
  assert.equal(madeByPatch({}).ok, false, 'made_by must be said, even as null');
  assert.equal(madeByPatch('human').ok, false);
  assert.equal(madeByPatch(null).ok, false);
});

test('a member entry is the member, in the file\'s words', () => {
  const entry = memberEntry(members()[3]);
  assert.deepEqual(entry, {
    url: 'https://pages.example/delta/',
    slug: 'delta',
    name: 'Delta',
    feed: 'https://pages.example/delta/feed',
    made_by: 'both',
    status: 'active',
    since: '2026-09-03T00:00:00.000Z',
    checked: '2026-09-11T00:00:00.000Z',
  });
});
