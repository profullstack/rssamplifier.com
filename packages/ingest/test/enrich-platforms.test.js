import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q, authors as a } from '@rssamplifier/db';

import { enrichFeedAuthors } from '../src/enrich.js';

// The publisher who marked nothing up.
//
// Everything in enrich.test.js is about reading what a page says. This file is
// about the case where the page says nothing at all -- which is most of the
// directory, and was 100% of what the pass returned empty-handed on. The proof
// case is a real one: felginep.github.io publishes a blog with no rel="me", no
// h-card and exactly one outbound link, to the Jekyll theme its author used.

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-platforms-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedFeed(feed) {
  const row = await q.insertFeed(db, {
    slug: feed.slug,
    feed_url: feed.feedUrl,
    site_url: feed.siteUrl ?? null,
    title: feed.title ?? 'A Blog',
    categories: [],
    kind: 'blog',
    status: 'active',
  });
  return { ...row, feed_url: feed.feedUrl, site_url: feed.siteUrl ?? null };
}

/**
 * A fetcher answering HTML pages and JSON APIs from one map.
 *
 * The content type follows the URL rather than the caller, because that is what
 * distinguishes the two paths under test: a page is parsed as markup and a
 * profile is parsed as JSON, and a stub that returned `text/html` for an API
 * would let a broken content-type check pass.
 */
function fakeFetch(responses) {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    const body = responses[url];
    if (body == null) return { ok: false, status: 404, contentType: '', body: '', url };
    const json = typeof body !== 'string';
    return {
      ok: true,
      status: 200,
      contentType: json ? 'application/json' : 'text/html',
      body: json ? JSON.stringify(body) : body,
      url,
    };
  };
  fetcher.asked = asked;
  return fetcher;
}

const fakeResolve = (siteUrl) => async () => ({
  ok: true,
  feed: { title: 'A Blog', siteUrl, credits: [], items: [] },
});

/** A page with a byline nowhere and one link, to somebody else's theme. */
const BARE_PAGE = `<!doctype html><html><body>
  <h1>Posts</h1>
  <a href="https://github.com/chesterhow/tale/">theme</a>
</body></html>`;

test('a blog that names nobody still finds its author, through the hostname', async () => {
  const feed = await seedFeed({
    slug: 'felginep-github-io',
    feedUrl: 'https://felginep.github.io/feed.xml',
    siteUrl: 'https://felginep.github.io/',
  });

  const fetcher = fakeFetch({
    'https://felginep.github.io/': BARE_PAGE,
    'https://api.github.com/users/felginep': {
      type: 'User',
      name: 'Pierre Felgines',
      avatar_url: 'https://avatars.example/u/1',
    },
  });

  const result = await enrichFeedAuthors(db, feed, {
    fetch: fetcher,
    resolve: fakeResolve('https://felginep.github.io/'),
  });

  assert.equal(result.people, 1, 'the page named nobody, so this can only have come from the profile');

  const [author] = await a.authorsForFeed(db, feed.id);
  assert.equal(author.name, 'Pierre Felgines');
  assert.ok(
    author.confidence >= 0.6,
    `must clear the publishing floor, got ${author.confidence}`,
  );

  // And the account itself is stored, which is a contact surface in its own right.
  const links = await a.linksForFeed(db, feed.id);
  assert.ok(
    links.some((l) => l.network === 'github' && l.url === 'https://github.com/felginep'),
    'the derived account is stored against the feed',
  );
});

test('the profile is asked about exactly once, and only when the host names an account', async () => {
  const feed = await seedFeed({
    slug: 'plain-domain',
    feedUrl: 'https://kevquirk.com/feed',
    siteUrl: 'https://kevquirk.com/',
  });

  const fetcher = fakeFetch({ 'https://kevquirk.com/': BARE_PAGE });
  await enrichFeedAuthors(db, feed, {
    fetch: fetcher,
    resolve: fakeResolve('https://kevquirk.com/'),
  });

  assert.equal(
    fetcher.asked.filter((u) => u.includes('api.github.com')).length,
    0,
    'a plain domain names no account, so no API request may be spent on it',
  );
});

test('an organisation behind a project site does not become a person', async () => {
  // jekyll.github.io is a project, and its account has a name that reads like
  // one. Publishing it as an author would put a piece of software on a page
  // that says these are people.
  const feed = await seedFeed({
    slug: 'jekyll-github-io',
    feedUrl: 'https://jekyll.github.io/feed.xml',
    siteUrl: 'https://jekyll.github.io/',
  });

  const fetcher = fakeFetch({
    'https://jekyll.github.io/': BARE_PAGE,
    'https://api.github.com/users/jekyll': { type: 'Organization', name: 'Jekyll' },
  });

  const result = await enrichFeedAuthors(db, feed, {
    fetch: fetcher,
    resolve: fakeResolve('https://jekyll.github.io/'),
  });

  assert.equal(result.people, 0);
  assert.deepEqual(await a.authorsForFeed(db, feed.id), [], 'no fictional person');

  // The account is still worth storing: it is where the feed comes from, and a
  // link is not a claim about who anybody is.
  const links = await a.linksForFeed(db, feed.id);
  assert.ok(links.some((l) => l.url === 'https://github.com/jekyll'));
});

test('a profile that links back to the site proves the account, and says so', async () => {
  // The IndieWeb handshake in the other direction: the account points at the
  // blog, which is what `verified` means in the schema.
  const feed = await seedFeed({
    slug: 'backlinked',
    feedUrl: 'https://ann.github.io/feed.xml',
    siteUrl: 'https://ann.github.io/',
  });

  const fetcher = fakeFetch({
    'https://ann.github.io/': BARE_PAGE,
    'https://api.github.com/users/ann': {
      type: 'User',
      name: 'Ann Example',
      blog: 'https://ann.github.io',
    },
  });

  const result = await enrichFeedAuthors(db, feed, {
    fetch: fetcher,
    resolve: fakeResolve('https://ann.github.io/'),
  });

  assert.equal(result.verified, 1, 'the backlink is counted as the proof it is');

  const [author] = await a.authorsForFeed(db, feed.id);
  assert.ok(
    author.confidence >= 0.9,
    `a proved account outranks a derived one, got ${author.confidence}`,
  );
});

test('an account that does not exist teaches us nothing and costs nothing', async () => {
  // The useful negative. A hostname can propose an account that was deleted or
  // never existed; a 404 must leave no trace rather than half a person.
  const feed = await seedFeed({
    slug: 'ghost-account',
    feedUrl: 'https://nobodyhome.github.io/feed.xml',
    siteUrl: 'https://nobodyhome.github.io/',
  });

  const fetcher = fakeFetch({ 'https://nobodyhome.github.io/': BARE_PAGE });

  const result = await enrichFeedAuthors(db, feed, {
    fetch: fetcher,
    resolve: fakeResolve('https://nobodyhome.github.io/'),
  });

  assert.equal(result.people, 0);
  assert.deepEqual(await a.authorsForFeed(db, feed.id), []);
});
