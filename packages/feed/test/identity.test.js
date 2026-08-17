import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyLink,
  cleanName,
  feedCredits,
  identityFromHtml,
  identityKey,
  isRoleEmail,
  linksBackTo,
  linksFromBioPage,
  looksLikePersonName,
  mergeCredits,
  normalizeIdentityUrl,
  personalEmail,
  splitBylines,
} from '../src/identity.js';
import { parseFeed } from '../src/parse.js';

test('a profile URL is recognised and a page on the same host is not', () => {
  assert.deepEqual(classifyLink('https://github.com/ralyodio'), {
    network: 'github',
    url: 'https://github.com/ralyodio',
    handle: 'ralyodio',
  });

  // A repository is not a person, and this is the distinction that keeps a
  // blogroll of project links out of the authors table.
  assert.equal(classifyLink('https://github.com/ralyodio/some-repo'), null);
  assert.equal(classifyLink('https://github.com/'), null);
});

test('the fediverse is matched by shape, because it has no host list', () => {
  const hit = classifyLink('https://hachyderm.io/@jane');
  assert.equal(hit.network, 'fediverse');
  assert.equal(hit.handle, '@jane@hachyderm.io');

  // A named host that happens to share the shape is still that host.
  assert.equal(classifyLink('https://medium.com/@jane').network, 'medium');
});

test('tracking parameters and scheme differences collapse to one URL', () => {
  const a = normalizeIdentityUrl('http://x.com/chovy?utm_source=newsletter&ref=blog');
  const b = normalizeIdentityUrl('https://x.com/chovy/');
  assert.equal(a, b);
});

test('a link that is not a profile at all is refused', () => {
  assert.equal(classifyLink('https://example.com/about'), null);
  assert.equal(classifyLink('javascript:alert(1)'), null);
  assert.equal(classifyLink('/relative/path'), null);
  assert.equal(classifyLink(''), null);
});

test('a role mailbox never becomes a personal address', () => {
  assert.equal(isRoleEmail('info@example.com'), true);
  assert.equal(isRoleEmail('no-reply@example.com'), true);
  assert.equal(isRoleEmail('press.office@example.com'), true);
  assert.equal(isRoleEmail('jane@example.com'), false);

  assert.equal(personalEmail('jane@example.com (Jane Doe)'), 'jane@example.com');
  assert.equal(personalEmail('support@example.com'), '');
  assert.equal(classifyLink('mailto:info@example.com'), null);
});

test('a byline is cleaned of the furniture publishers wrap it in', () => {
  assert.equal(cleanName('By Jane Doe'), 'Jane Doe');
  assert.equal(cleanName('  Jane   Doe |'), 'Jane Doe');
  assert.equal(cleanName('jane@example.com (Jane Doe)'), 'Jane Doe');
});

test('a role is not a person and a handle is not a name', () => {
  assert.equal(looksLikePersonName('Jane Doe'), true);
  assert.equal(looksLikePersonName('Chovy'), true, 'a mononym is a name');
  assert.equal(looksLikePersonName('McDonald'), true, 'a real capital mid-surname');

  assert.equal(looksLikePersonName('webmaster'), false);
  assert.equal(looksLikePersonName('The Editors'), false);
  assert.equal(looksLikePersonName('user86791'), false);
  assert.equal(looksLikePersonName('KeizerHarm'), false, 'a username with the space taken out');
  assert.equal(looksLikePersonName('This is a whole sentence that landed here'), false);
});

test('a credit line naming three people is three people', () => {
  assert.deepEqual(splitBylines('Adam Wren, Dasha Burns and Will Steakin'), [
    'Adam Wren',
    'Dasha Burns',
    'Will Steakin',
  ]);

  // The person survives, the role does not.
  assert.deepEqual(splitBylines('Jane Doe and the editorial team'), ['Jane Doe']);
});

test('the same person credited twice is merged, strongest evidence winning', () => {
  const merged = mergeCredits([
    { name: 'Jane Doe', email: '', url: '', avatar: '', role: 'author', source: 'item-byline', confidence: 0.6 },
    {
      name: 'jane  doe',
      email: 'jane@example.com',
      url: 'https://jane.example',
      avatar: '',
      role: 'owner',
      source: 'itunes-owner',
      confidence: 0.85,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].email, 'jane@example.com');
  assert.equal(merged[0].role, 'owner', 'owner outranks author');
  assert.equal(merged[0].confidence, 0.85);
});

test('an RSS channel gives up its owner, and a post title masquerading as one does not', () => {
  const rss = `<rss><channel>
      <title>A Blog</title>
      <managingEditor>jane@jane.example (Jane Doe)</managingEditor>
      <item><title>On Tuesdays</title><dc:creator>On Tuesdays</dc:creator></item>
      <item><title>Second</title><dc:creator>Jane Doe</dc:creator></item>
    </channel></rss>`;

  const credits = parseFeed(rss, 'https://jane.example/feed.xml').credits;
  assert.equal(credits.length, 1, 'Blot writes the post title into dc:creator; that is not a person');
  assert.equal(credits[0].name, 'Jane Doe');
  assert.equal(credits[0].email, 'jane@jane.example');
  assert.equal(credits[0].role, 'owner');
});

test("an Atom feed's author is believed and its guest byline is not", () => {
  const atom = `<feed><title>T</title>
      <author><name>Sam Ruiz</name><email>sam@ruiz.example</email><uri>https://ruiz.example</uri></author>
      <entry><title>E</title><author><name>Guest Author</name></author></entry>
    </feed>`;

  const credits = parseFeed(atom, 'https://ruiz.example/atom.xml').credits;
  assert.equal(credits.length, 1);
  assert.equal(credits[0].name, 'Sam Ruiz');
  assert.equal(credits[0].url, 'https://ruiz.example/');
});

test('a podcast guest is not an author of the podcast', () => {
  const rss = `<rss><channel><title>Show</title>
      <podcast:person role="host" href="https://host.example" img="https://host.example/me.jpg">Ada Hall</podcast:person>
      <podcast:person role="guest">Bob Nkemelu</podcast:person>
    </channel></rss>`;

  const credits = feedCredits(
    { title: 'Show', 'podcast:person': [
      { '#text': 'Ada Hall', '@role': 'host', '@href': 'https://host.example', '@img': 'https://host.example/me.jpg' },
      { '#text': 'Bob Nkemelu', '@role': 'guest' },
    ] },
    [],
    'rss',
    'https://show.example/feed.xml',
  );

  assert.equal(credits.length, 1);
  assert.equal(credits[0].name, 'Ada Hall');
  assert.equal(credits[0].avatar, 'https://host.example/me.jpg');
  assert.ok(rss.includes('podcast:person'));
});

test('a page states its author in every way at once and they all agree', () => {
  const html = `<html><head>
      <link rel="me" href="https://mastodon.social/@jane">
      <meta name="author" content="Jane Doe">
      <script type="application/ld+json">
        {"@type":"Person","name":"Jane Doe","url":"https://jane.example",
         "description":"Writes about trains.","sameAs":["https://github.com/janedoe"]}
      </script>
    </head><body>
      <div class="h-card">
        <a class="u-url p-name" href="https://jane.example">Jane Doe</a>
        <a class="u-email" href="mailto:jane@jane.example">mail</a>
        <img class="u-photo" src="/me.jpg">
      </div>
      <footer><a href="https://linktr.ee/janedoe">links</a></footer>
    </body></html>`;

  const identity = identityFromHtml(html, 'https://jane.example/');

  assert.equal(identity.name, 'Jane Doe');
  assert.equal(identity.email, 'jane@jane.example');
  assert.equal(identity.avatar, 'https://jane.example/me.jpg', 'a relative photo resolves');
  assert.equal(identity.bio, 'Writes about trains.');

  const networks = identity.profiles.map((p) => p.network).sort();
  assert.deepEqual(networks, ['email', 'fediverse', 'github', 'linktree']);

  // rel="me" is the deliberate claim, and it keeps that provenance even though
  // the same page carries weaker links too.
  const fedi = identity.profiles.find((p) => p.network === 'fediverse');
  assert.equal(fedi.source, 'rel-me');

  assert.equal(identity.credits.length, 1, 'three statements about one person are one person');
});

test('a page that says nothing about anybody yields nothing', () => {
  const identity = identityFromHtml('<html><body><p>Hello.</p></body></html>', 'https://x.example/');
  assert.deepEqual(identity.credits, []);
  assert.deepEqual(identity.profiles, []);
  assert.equal(identity.name, '');
});

test('malformed JSON-LD costs its own block and nothing else', () => {
  const html = `<html><head>
      <script type="application/ld+json">{ not json </script>
      <script type="application/ld+json">{"@graph":[{"@type":"Person","name":"Ada Hall"}]}</script>
    </head><body></body></html>`;

  const identity = identityFromHtml(html, 'https://x.example/');
  assert.equal(identity.credits.length, 1);
  assert.equal(identity.credits[0].name, 'Ada Hall', 'found nested inside @graph');
});

test('a links page gives up the accounts behind it, including the ones only in its JSON', () => {
  const html = `<html><body>
      <a href="https://github.com/jd">code</a>
      <a href="https://linktr.ee/jd">this page</a>
      <script>{"links":[{"url":"https://mastodon.social/@jd"}]}</script>
    </body></html>`;

  const links = linksFromBioPage(html, 'https://linktr.ee/jd');
  const networks = links.map((l) => l.network).sort();

  assert.deepEqual(networks, ['fediverse', 'github']);
  assert.ok(
    links.every((l) => l.source === 'linktree'),
    'a link found here is known to belong to whoever owns the page',
  );
});

test('the rel="me" handshake is only answered by a page that links back', () => {
  const backlink = '<html><head><link rel="me" href="https://jane.example/"></head></html>';
  const mention = '<html><body><a href="https://jane.example/">a blog I like</a></body></html>';

  assert.equal(linksBackTo(backlink, 'https://jane.example'), true);
  assert.equal(linksBackTo(mention, 'https://jane.example'), false, 'a mention is not a claim');
  assert.equal(linksBackTo(backlink, 'https://someone-else.example'), false);
});

test('identity is keyed on a URL, and two strangers who share a name stay apart', () => {
  const withUrl = identityKey({ name: 'John Smith', url: 'https://jsmith.example' }, 'https://a.example/f');
  const sameUrlElsewhere = identityKey({ name: 'J. Smith', url: 'https://jsmith.example/' }, 'https://b.example/f');
  assert.equal(withUrl, sameUrlElsewhere, 'a URL they control is the same person wherever it is found');

  const onA = identityKey({ name: 'John Smith' }, 'https://a.example/feed.xml');
  const onB = identityKey({ name: 'John Smith' }, 'https://b.example/feed.xml');
  assert.notEqual(onA, onB, 'without a URL, a shared name is not evidence of a shared person');

  // www is not a different site.
  assert.equal(
    identityKey({ name: 'John Smith' }, 'https://www.a.example/feed.xml'),
    onA,
  );
});
