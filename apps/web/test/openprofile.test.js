import assert from 'node:assert/strict';
import { test } from 'node:test';

import { broadcasts, parseOpenProfile, topics as topicsOf } from '@profullstack/openprofile';

import {
  authorProfile,
  generateAuthorProfile,
  overridesFromBody,
  overridesFromForm,
  profileUrl,
} from '../src/lib/openprofile.js';
import { claimVerdict, isOwner, linksBack } from '../src/lib/profileAuth.js';
import { principalFromToken } from '../src/lib/openaccess.js';

const BASE = 'https://rssamplifier.test';

/** An author with a podcast they own and a blog they write in. */
const ADA = {
  id: 'a1',
  slug: 'ada-lovelace',
  name: 'Ada Lovelace',
  bio: 'Wrote the first program.\nMore about that later.',
  avatar_url: 'https://ada.example/ada.jpg',
  site_url: 'https://ada.example',
  email: 'ada@example.com',
  links: [
    { network: 'bluesky', url: 'https://bsky.app/profile/ada.example', handle: '@ada.example' },
    { network: 'github', url: 'https://github.com/ada', handle: 'ada' },
    { network: 'email', url: 'mailto:ada@example.com', handle: null },
    { network: 'website', url: 'https://ada.example', handle: null },
  ],
};
const FEEDS = [
  {
    id: 'f1',
    slug: 'analytical-engine',
    title: 'The Analytical Engine',
    kind: 'podcast',
    role: 'owner',
    feed_url: 'https://ada.example/podcast/feed.xml',
    site_url: 'https://ada.example/podcast',
    language: 'en',
  },
  { id: 'f2', slug: 'group-blog', title: 'Group Blog', kind: 'blog', role: 'author', feed_url: 'https://g.example/feed' },
  {
    id: 'f3',
    slug: 'other-show',
    title: 'Somebody Elses Show',
    kind: 'podcast',
    role: 'author',
    feed_url: 'https://o.example/feed',
  },
];
const TOPICS = new Map([
  ['f1', [{ keyword: 'history', source: 'category' }, { keyword: 'mathematics', source: 'content' }]],
  ['f2', [{ keyword: 'mathematics', source: 'content' }, { keyword: 'writing', source: 'category' }]],
]);

test('the generated file says what the author published, and nothing they did not', () => {
  const doc = generateAuthorProfile({ person: ADA, feeds: FEEDS, topicsByFeed: TOPICS, base: BASE });

  assert.equal(doc.name, 'Ada Lovelace');
  const identity = Object.fromEntries(doc.identity.map((e) => [e.key, e.value]));
  assert.deepEqual(identity, {
    Kind: 'person',
    Handle: 'ada.example',
    Web: 'https://ada.example',
    Avatar: 'https://ada.example/ada.jpg',
  });
  assert.equal('Email' in identity, false, 'the published address is not carried into the file');
  assert.equal(doc.headline, 'Wrote the first program.', 'first line of the bio');

  const accounts = doc.sections.find((s) => s.name === 'accounts');
  assert.equal(accounts.body, '- [Bluesky](https://bsky.app/profile/ada.example)\n- [GitHub](https://github.com/ada)\n- https://ada.example');

  assert.deepEqual(topicsOf(doc), ['history', 'mathematics', 'writing'], 'the union, strongest feed first');

  const shows = broadcasts(doc);
  assert.equal(shows.length, 1, "only the show they own; somebody else's podcast is not theirs to describe");
  assert.deepEqual(shows[0], {
    Show: 'The Analytical Engine',
    Kind: 'podcast',
    Language: 'en',
    Feed: 'https://ada.example/podcast/feed.xml',
    Listen: 'https://ada.example/podcast',
    Topics: 'history',
  });
  assert.equal(shows[0].Topics, 'history', "a show's Topics are the publisher's own categories, not counted phrases");
  assert.equal('Seeking' in shows[0], false);
  assert.equal('Since' in shows[0], false, 'the feed window is not when the show started');
  assert.equal(doc.sections.some((s) => s.name === 'guest'), false, 'no Guest section unless the person wrote one');

  const links = doc.sections.find((s) => s.name === 'links');
  assert.match(links.body, /^- \[The Analytical Engine\]\(https:\/\/rssamplifier\.test\/analytical-engine\)/, 'owned feeds first');
});

test('two owned shows become ### groups in one Broadcast section', () => {
  const feeds = [FEEDS[0], { ...FEEDS[2], role: 'owner' }];
  const doc = generateAuthorProfile({ person: ADA, feeds, topicsByFeed: TOPICS, base: BASE });
  const shows = broadcasts(doc);
  assert.deepEqual(shows.map((s) => s.Show), ['The Analytical Engine', 'Somebody Elses Show']);
  assert.equal(shows[1].Listen, `${BASE}/other-show`, 'a show with no site listens on its directory page');
});

test('the overlay wins per part, the rest stays generated, and the file round-trips', () => {
  const overrides = {
    headline: 'Countess, programmer.',
    identity: { Email: 'ada@example.com', Location: 'London', Avatar: null },
    sections: { guest: '- **Available**: yes\n- **Expertise**: early computing', links: 'none' },
  };
  const { markdown, doc } = authorProfile({ person: ADA, feeds: FEEDS, topicsByFeed: TOPICS, base: BASE, overrides });
  assert.equal(doc.headline, 'Countess, programmer.');
  const identity = Object.fromEntries(doc.identity.map((e) => [e.key, e.value]));
  assert.equal(identity.Email, 'ada@example.com', 'the owner chose to publish it');
  assert.equal(identity.Location, 'London');
  assert.equal('Avatar' in identity, false);
  assert.deepEqual(doc.sections.map((s) => s.name), ['accounts', 'topics', 'broadcast', 'guest']);
  assert.equal(broadcasts(doc)[0].Show, 'The Analytical Engine', 'untouched sections are still generated');

  const back = parseOpenProfile(markdown);
  assert.equal(back.name, 'Ada Lovelace');
  assert.equal(back.sections.find((s) => s.name === 'guest').body, '- **Available**: yes\n- **Expertise**: early computing');
});

test('a PUT body as Markdown becomes the whole overlay; as JSON it is a patch', () => {
  const generated = generateAuthorProfile({ person: ADA, feeds: FEEDS, topicsByFeed: TOPICS, base: BASE });

  const edited = '# Ada Lovelace\n\n- Kind: person\n- Web: https://ada.example\n\nCountess.\n\n## Guest\n\n- **Available**: yes\n';
  const fromMd = overridesFromBody({ contentType: 'text/markdown; charset=utf-8', text: edited, existing: null, generated });
  assert.equal(fromMd.error, undefined);
  assert.equal(fromMd.overrides.headline, 'Countess.');
  assert.equal(fromMd.overrides.identity.Avatar, null, 'a key the file dropped is removed');
  assert.equal(fromMd.overrides.sections.accounts, 'none', 'a section the file dropped is dropped');
  assert.equal(fromMd.overrides.sections.guest, '- **Available**: yes');

  const fromJson = overridesFromBody({
    contentType: 'application/json',
    text: JSON.stringify({ sections: { guest: null }, identity: { Location: 'London' }, public: false }),
    existing: fromMd.overrides,
    generated,
  });
  assert.equal(fromJson.public, false);
  assert.equal(fromJson.overrides.sections.guest, 'none');
  assert.equal(fromJson.overrides.sections.accounts, 'none', 'the stored overlay is kept');
  assert.equal(fromJson.overrides.identity.Location, 'London');
  assert.equal(fromJson.overrides.headline, 'Countess.');

  assert.equal(overridesFromBody({ contentType: 'application/json', text: '{nope', existing: null, generated }).error, 'bad JSON');
  assert.equal(overridesFromBody({ contentType: 'text/markdown', text: '  ', existing: null, generated }).error, 'empty document');
});

test('the web form is one box per part; an emptied box drops the section', () => {
  const form = new FormData();
  form.set('name', 'Ada');
  form.set('headline', '');
  form.set('identity', 'Kind: person\n- **Web**: https://ada.example\nEmail:');
  form.set('section_topics', '- engines');
  form.set('section_guest', '');
  const { overrides, public: isPublic } = overridesFromForm(form);
  assert.equal(overrides.name, 'Ada');
  assert.equal(overrides.headline, null);
  assert.deepEqual(overrides.identity, { Kind: 'person', Web: 'https://ada.example', Email: null });
  assert.equal(overrides.sections.topics, '- engines');
  assert.equal(overrides.sections.guest, 'none');
  assert.equal('accounts' in overrides.sections, false, 'a box the form did not have is not touched');
  assert.equal(isPublic, false, 'an unticked checkbox is absent from the form');
});

test('isOwner: only the claimant, and an OpenAccess principal only with the scope', () => {
  const claimed = { claimed_at: '2026-09-13T00:00:00Z', owner_user_id: 'u1', owner_principal: 'oa:1' };
  assert.equal(isOwner({ kind: 'session', userId: 'u1', scopes: [] }, claimed), true);
  assert.equal(isOwner({ kind: 'apikey', userId: 'u2', scopes: [] }, claimed), false);
  assert.equal(isOwner({ kind: 'openaccess', principal: 'oa:1', scopes: ['openprofile:edit'] }, claimed), true);
  assert.equal(isOwner({ kind: 'openaccess', principal: 'oa:1', scopes: ['podcasts:submit'] }, claimed), false);
  assert.equal(isOwner({ kind: 'session', userId: 'u1', scopes: [] }, null), false, 'unclaimed is nobody\'s');
  assert.equal(isOwner({ kind: 'session', userId: 'u1', scopes: [] }, { ...claimed, claimed_at: null }), false);
});

test('a claim is verified by the published address, or by the site linking back', async () => {
  const person = { id: 'a1', slug: 'ada-lovelace', email: 'Ada@Example.com', site_url: 'https://ada.example' };
  const urls = { profileUrl: `${BASE}/authors/ada-lovelace/openprofile.md`, pageUrl: `${BASE}/authors/ada-lovelace` };

  assert.deepEqual(await claimVerdict({ caller: { kind: null, scopes: [] }, person, profile: null, ...urls }), {
    ok: false,
    status: 401,
    error: 'sign-in-required',
  });

  const byEmail = await claimVerdict({ caller: { kind: 'session', userId: 'u1', email: 'ada@example.com', scopes: [] }, person, profile: null, ...urls });
  assert.deepEqual(byEmail, { ok: true, method: 'email' });

  const stranger = { kind: 'session', userId: 'u9', email: 'bob@example.com', scopes: [] };
  const noLink = await claimVerdict({ caller: stranger, person, profile: null, ...urls, fetchText: async () => '<html><a href="https://elsewhere">x</a></html>' });
  assert.equal(noLink.ok, false);
  assert.equal(noLink.status, 403);
  assert.match(noLink.error, /sign in as a\*\*\*@example\.com/);

  const byLink = await claimVerdict({
    caller: stranger,
    person,
    profile: null,
    ...urls,
    fetchText: async () => `<html><head><link rel="openprofile" href="${urls.profileUrl}"></head></html>`,
  });
  assert.deepEqual(byLink, { ok: true, method: 'linkback' });

  const taken = { claimed_at: '2026-09-13T00:00:00Z', owner_user_id: 'u1', owner_principal: null, claim_method: 'email' };
  const second = await claimVerdict({ caller: stranger, person, profile: taken, ...urls, fetchText: async () => '' });
  assert.deepEqual(second, { ok: false, status: 409, error: 'already-claimed' });
  const owner = await claimVerdict({ caller: { kind: 'session', userId: 'u1', email: 'ada@example.com', scopes: [] }, person, profile: taken, ...urls });
  assert.deepEqual(owner, { ok: true, method: 'email' });

  const admin = await claimVerdict({ caller: { kind: 'session', userId: 'u7', email: 'root@rssamplifier.com', scopes: [] }, person, profile: null, ...urls, admins: ['root@rssamplifier.com'] });
  assert.deepEqual(admin, { ok: true, method: 'admin' });

  const noScope = await claimVerdict({ caller: { kind: 'openaccess', principal: 'oa:1', email: 'ada@example.com', scopes: [] }, person, profile: null, ...urls });
  assert.equal(noScope.status, 403);
});

test('linksBack reads rel="openprofile" and rel="me" in either attribute order', () => {
  const target = 'https://rssamplifier.test/authors/ada/openprofile.md';
  assert.equal(linksBack(`<a rel="me" href="${target}/">me</a>`, [target]), true);
  assert.equal(linksBack(`<link href='${target}' rel='alternate openprofile'>`, [target]), true);
  assert.equal(linksBack(`<a href="${target}">no rel</a>`, [target]), false);
  assert.equal(linksBack(`<a rel="me" href="https://other.example">x</a>`, [target]), false);
});

test('an OpenAccess token yields a principal with scopes and an email when the hub gave one', async () => {
  const p = await principalFromToken('t', { verify: async () => ({ sub: 'oa:1', scope: 'openprofile:edit x', email: 'Ada@Example.com' }) });
  assert.deepEqual(p, { sub: 'oa:1', scopes: ['openprofile:edit', 'x'], email: 'ada@example.com' });
  assert.equal(await principalFromToken('t', { verify: async () => { throw new Error('bad'); } }), null);
  assert.equal(await principalFromToken(null), null);
});

test('small helpers', () => {
  assert.equal(profileUrl(BASE, 'ada lovelace'), `${BASE}/authors/ada%20lovelace/openprofile.md`);
});
