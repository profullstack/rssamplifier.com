import test from 'node:test';
import assert from 'node:assert/strict';

import { hostIdentity, identityFromProfile, profileRequest } from '../src/platforms.js';

// What is tested here is the half of author enrichment that reads what nobody
// published: the account named by a hostname, and the profile behind it. The
// expensive mistake in this direction is not missing somebody, it is inventing
// them -- so most of these are about what must *not* be derived.

test('a blog on a personal platform names its owner in the hostname', () => {
  // The case this module exists for. felginep.github.io publishes no rel="me",
  // no h-card and one outbound link, to its Jekyll theme -- so every other
  // source finds nobody, while the account is sitting in the address.
  assert.deepEqual(hostIdentity('https://felginep.github.io/feed.xml'), [
    {
      network: 'github',
      url: 'https://github.com/felginep',
      handle: 'felginep',
      source: 'host-derived',
      confidence: 0.5,
    },
  ]);
});

test('the feed URL and the site URL are both read, and agree on one account', () => {
  // They disagree often -- a blog on its own domain with a feed proxied through
  // a platform names its author in only one of them -- but when both name the
  // same account it must not be stored twice.
  const found = hostIdentity('https://jane.substack.com/feed', 'https://jane.substack.com/');
  assert.equal(found.length, 1);
  assert.equal(found[0].network, 'substack');
  assert.equal(found[0].handle, 'jane');
});

test("a platform's own subdomains are not people", () => {
  for (const url of [
    'https://www.github.io/',
    'https://docs.github.io/',
    'https://blog.substack.com/',
    'https://api.micro.blog/',
  ]) {
    assert.deepEqual(hostIdentity(url), [], url);
  }
});

test('a host that is nobody in particular derives nothing', () => {
  // The overwhelming majority of the directory. Deriving a "website" link back
  // to the feed we are already enriching would be a row that teaches nobody
  // anything, so a plain domain yields nothing at all.
  assert.deepEqual(hostIdentity('https://kevquirk.com/feed'), []);
  assert.deepEqual(hostIdentity('https://example.wordpress.com/feed'), []);
  assert.deepEqual(hostIdentity('not a url'), []);
  assert.deepEqual(hostIdentity('ftp://example.github.io/'), []);
});

test('a derived account stays below the publishing floor until something confirms it', () => {
  // 0.6 is what /api/authors publishes at. A hostname is a strong hint and not
  // a fact: it is the profile answering that turns it into one.
  const [account] = hostIdentity('https://felginep.github.io/');
  assert.ok(account.confidence < 0.6, 'a bare derivation must not be publishable on its own');
});

test('a GitHub profile is read for the fields a person filled in', () => {
  const profile = identityFromProfile('github', {
    type: 'User',
    name: 'Pierre Felgines',
    bio: 'iOS developer',
    avatar_url: 'https://avatars.example/u/1',
    blog: 'felginep.github.io',
    email: 'pierre@example.com',
    twitter_username: 'pfelgines',
  });

  assert.equal(profile.name, 'Pierre Felgines');
  assert.equal(profile.kind, 'user');
  assert.deepEqual(
    profile.links.map((l) => [l.network, l.url]),
    [
      // A profile field typed without a scheme is not a URL until it has one.
      ['website', 'https://felginep.github.io'],
      ['email', 'mailto:pierre@example.com'],
      ['twitter', 'https://x.com/pfelgines'],
    ],
  );
});

test('an organisation is not a person', () => {
  // jekyll.github.io resolves to an account whose "name" is a product. Turning
  // that into an author row would publish a project as a human being.
  const profile = identityFromProfile('github', { type: 'Organization', name: 'Jekyll' });
  assert.equal(profile.kind, 'org');
});

test("a fediverse profile carries the instance's own rel=me verification", () => {
  // The best source in the module: the instance already followed the link and
  // found a backlink, so the IndieWeb handshake arrives done.
  const profile = identityFromProfile('fediverse', {
    display_name: 'Kev Quirk',
    note: '<p>I work in <b>InfoSec</b>.</p>',
    url: 'https://fosstodon.org/@kev',
    avatar_static: 'https://cdn.example/a.png',
    fields: [
      {
        name: 'Blog',
        value: '<a href="https://kevquirk.com" rel="me"><span>kevquirk.com</span></a>',
        verified_at: '2022-10-22T22:21:08.251+00:00',
      },
      { name: 'Unproven', value: '<a href="https://example.org">example.org</a>', verified_at: null },
    ],
  });

  assert.equal(profile.name, 'Kev Quirk');
  // The bio is HTML on this platform and prose everywhere else.
  assert.equal(profile.bio, 'I work in InfoSec.');

  const verified = profile.links.find((l) => l.url === 'https://kevquirk.com');
  assert.equal(verified.verified, true);
  assert.ok(verified.confidence > 0.9);

  const unproven = profile.links.find((l) => l.url === 'https://example.org');
  assert.equal(unproven.verified, false, 'an unverified field is stored, but not as proof');
});

test('a request is described for the platforms that answer, and refused for the rest', () => {
  assert.equal(
    profileRequest({ network: 'github', handle: 'felginep' }).url,
    'https://api.github.com/users/felginep',
  );
  // The fediverse has no host list, so the endpoint comes out of the handle.
  assert.equal(
    profileRequest({ network: 'fediverse', handle: '@kev@fosstodon.org' }).url,
    'https://fosstodon.org/api/v1/accounts/lookup?acct=kev',
  );
  assert.equal(profileRequest({ network: 'linkedin', handle: 'someone' }), null);
  assert.equal(profileRequest({ network: 'github', handle: '' }), null);
  assert.equal(profileRequest({ network: 'fediverse', handle: 'no-host' }), null);
});

test('a GitHub token is sent when there is one, because 60 an hour is not a budget', () => {
  const anonymous = profileRequest({ network: 'github', handle: 'x' });
  assert.equal(anonymous.headers.authorization, undefined);

  const authed = profileRequest({ network: 'github', handle: 'x' }, { token: 'ghp_test' });
  assert.equal(authed.headers.authorization, 'Bearer ghp_test');
});

test('a malformed profile body is nothing, not a throw', () => {
  for (const body of [null, undefined, 'not json', 42]) {
    const profile = identityFromProfile('github', body);
    assert.deepEqual(profile.links, []);
    assert.equal(profile.name, '');
  }
  // GitLab answers its user search with an array, and an empty one when the
  // handle matched nobody.
  assert.equal(identityFromProfile('gitlab', []).name, '');
});
