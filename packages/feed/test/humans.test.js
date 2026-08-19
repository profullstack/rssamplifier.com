import test from 'node:test';
import assert from 'node:assert/strict';

import { identityFromHumansTxt } from '../src/identity.js';

// humans.txt is the one source here written to answer the question we are
// asking, so the parsing has to be right about two things: whose links are
// whose, and which section of the file is talking about this site's people
// rather than about somebody else's work.

const TEAM = `/* TEAM */
Chef: Jane Doe
Site: https://jane.example
Mastodon: @jane@example.social
Contact: jane@example.com

Developer: Bob Smith
Twitter: @bobsmith

/* THANKS */
Inspiration: Famous Person
Site: https://famous.example

/* SITE */
Standards: HTML5
Language: English
`;

test('each person keeps their own accounts', () => {
  // The failure this guards against is quiet and wrong rather than empty: a
  // parser that collects links globally hands Jane's Mastodon to Bob.
  const { credits, profiles } = identityFromHumansTxt(TEAM, 'https://blog.example/');

  assert.deepEqual(
    credits.map((c) => c.name),
    ['Jane Doe', 'Bob Smith'],
  );

  const jane = credits[0];
  assert.equal(jane.email, 'jane@example.com');
  assert.equal(jane.url, 'https://jane.example/');
  assert.equal(credits[1].email, '', 'Bob published no address and must not inherit one');

  assert.deepEqual(
    profiles.map((p) => p.network).sort(),
    ['email', 'fediverse', 'twitter', 'website'],
  );
  assert.ok(profiles.every((p) => p.source === 'humans-txt'));
});

test('the THANKS section is not this blog\'s authors', () => {
  // It exists to credit other people's work — a library, an inspiration, a
  // designer at another company. Reading it as authorship would attribute a
  // blog to whoever its author admires.
  const { credits } = identityFromHumansTxt(TEAM, 'https://blog.example/');
  assert.ok(!credits.some((c) => c.name === 'Famous Person'));
});

test('lines that describe the site are not links', () => {
  const { profiles } = identityFromHumansTxt(TEAM, 'https://blog.example/');
  assert.ok(!profiles.some((p) => /HTML5|English/i.test(p.url)));
});

test('a role is still not a person here', () => {
  // The same rule that governs a byline. A file can say "Developer: the web
  // team", and that names nobody.
  const { credits } = identityFromHumansTxt(
    '/* TEAM */\nDeveloper: the web team\nName: Editor\nContact: info@example.com',
    'https://blog.example/',
  );
  assert.deepEqual(credits, []);
});

test('a bare handle becomes the account the key says it is', () => {
  const { profiles } = identityFromHumansTxt(
    '/* TEAM */\nName: Ann Example\nGithub: annex\nBluesky: ann.example\nLinkedin: ann-example',
    'https://blog.example/',
  );

  assert.deepEqual(
    profiles.map((p) => p.url),
    [
      'https://github.com/annex',
      'https://bsky.app/profile/ann.example',
      'https://www.linkedin.com/in/ann-example',
    ],
  );
});

test('a 404 page dressed as a text file is not a humans.txt', () => {
  // Plenty of servers answer every path with their HTML 404. Parsing that would
  // turn a stylesheet reference into somebody's website.
  assert.deepEqual(identityFromHumansTxt('<!doctype html><html><body>Not found</body></html>'), {
    credits: [],
    profiles: [],
  });
  assert.deepEqual(identityFromHumansTxt(''), { credits: [], profiles: [] });
  assert.deepEqual(identityFromHumansTxt(null), { credits: [], profiles: [] });
});

test('a file with no sections at all is read as a team', () => {
  // The convention is loose and plenty of files skip the header entirely.
  const { credits } = identityFromHumansTxt('Name: Ann Example\nSite: https://ann.example');
  assert.deepEqual(
    credits.map((c) => c.name),
    ['Ann Example'],
  );
});
