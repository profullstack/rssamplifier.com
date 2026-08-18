import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q, authors as a } from '@rssamplifier/db';

import { enrichDue, enrichFeedAuthors, storeCredits } from '../src/enrich.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-enrich-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A feed row to hang authors off.
 *
 * @param {object} feed
 * @returns {Promise<{ id: string, slug: string }>}
 */
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

  // The shape enrichFeedAuthors is given by dueForAuthors, so the tests below
  // exercise it the way the pass does.
  return { ...row, feed_url: feed.feedUrl, site_url: feed.siteUrl ?? null };
}

/**
 * A fetcher that answers from a map and refuses everything else, so a test
 * that reaches for a page it did not stub fails loudly rather than silently.
 *
 * @param {Record<string, string>} pages
 */
function fakeFetch(pages) {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    const body = pages[url];
    if (body == null) return { ok: false, status: 404, contentType: '', body: '', url };
    return { ok: true, status: 200, contentType: 'text/html', body, url };
  };
  fetcher.asked = asked;
  return fetcher;
}

/** A resolveFeed stand-in returning a parsed feed with the given credits. */
function fakeResolve(credits, siteUrl = '') {
  return async () => ({ ok: true, feed: { title: 'A Blog', siteUrl, credits, items: [] } });
}

test('a credit becomes an author, a feed_authors row and a link', async () => {
  const feed = await seedFeed({ slug: 'alpha', feedUrl: 'https://alpha.example/feed.xml' });

  const stored = await storeCredits(db, { id: feed.id, feed_url: 'https://alpha.example/feed.xml' }, [
    {
      name: 'Jane Doe',
      email: 'jane@alpha.example',
      url: 'https://jane.example',
      avatar: '',
      role: 'owner',
      source: 'itunes-owner',
      confidence: 0.85,
    },
  ]);

  assert.equal(stored.people, 1);

  const [author] = await a.authorsForFeed(db, feed.id);
  assert.equal(author.name, 'Jane Doe');
  assert.equal(author.slug, 'jane-doe');
  assert.equal(author.role, 'owner');
  assert.equal(author.email, 'jane@alpha.example');

  const networks = author.links.map((l) => l.network).sort();
  assert.deepEqual(networks, ['email', 'website']);
});

test('storing the same credit again updates one row rather than adding a second', async () => {
  const feed = await seedFeed({ slug: 'beta', feedUrl: 'https://beta.example/feed.xml' });
  const credit = {
    name: 'Ada Hall',
    email: '',
    url: 'https://ada.example',
    avatar: '',
    role: 'author',
    source: 'item-byline',
    confidence: 0.6,
  };

  await storeCredits(db, { id: feed.id, feed_url: 'https://beta.example/feed.xml' }, [credit]);
  await storeCredits(db, { id: feed.id, feed_url: 'https://beta.example/feed.xml' }, [
    { ...credit, email: 'ada@ada.example', role: 'owner', confidence: 0.85 },
  ]);

  const found = await a.authorsForFeed(db, feed.id);
  assert.equal(found.length, 1, 'the pass re-runs over the directory; it must not duplicate people');
  assert.equal(found[0].email, 'ada@ada.example', 'a later pass fills in what the first did not know');
  assert.equal(found[0].role, 'owner');
  assert.equal(Number(found[0].confidence), 0.85, 'better evidence raises confidence');
});

test('a second pass that learns less does not erase what the first learned', async () => {
  const feed = await seedFeed({ slug: 'gamma', feedUrl: 'https://gamma.example/feed.xml' });
  const base = { name: 'Sam Ruiz', url: 'https://sam.example', avatar: '', role: 'owner', source: 'h-card' };

  await storeCredits(db, { id: feed.id, feed_url: 'https://gamma.example/feed.xml' }, [
    { ...base, email: 'sam@sam.example', confidence: 0.85 },
  ]);
  // The site was briefly unreachable and only the name came back.
  await storeCredits(db, { id: feed.id, feed_url: 'https://gamma.example/feed.xml' }, [
    { ...base, email: '', confidence: 0.5 },
  ]);

  const [author] = await a.authorsForFeed(db, feed.id);
  assert.equal(author.email, 'sam@sam.example');
  assert.equal(Number(author.confidence), 0.85);
});

test('the same person on two feeds is one author, and two namesakes are two', async () => {
  const one = await seedFeed({ slug: 'one', feedUrl: 'https://one.example/feed.xml' });
  const two = await seedFeed({ slug: 'two', feedUrl: 'https://two.example/feed.xml' });

  const shared = {
    name: 'Kim Alvarez',
    email: '',
    url: 'https://kim.example',
    avatar: '',
    role: 'owner',
    source: 'h-card',
    confidence: 0.8,
  };
  await storeCredits(db, { id: one.id, feed_url: 'https://one.example/feed.xml' }, [shared]);
  await storeCredits(db, { id: two.id, feed_url: 'https://two.example/feed.xml' }, [shared]);

  const onOne = await a.authorsForFeed(db, one.id);
  const onTwo = await a.authorsForFeed(db, two.id);
  assert.equal(onOne[0].id, onTwo[0].id, 'a URL they control merges them');

  // The same name with no URL, found on two unrelated sites, is two people.
  const three = await seedFeed({ slug: 'three', feedUrl: 'https://three.example/feed.xml' });
  const four = await seedFeed({ slug: 'four', feedUrl: 'https://four.example/feed.xml' });
  const nameOnly = { ...shared, url: '', name: 'John Smith' };

  await storeCredits(db, { id: three.id, feed_url: 'https://three.example/feed.xml' }, [nameOnly]);
  await storeCredits(db, { id: four.id, feed_url: 'https://four.example/feed.xml' }, [nameOnly]);

  const onThree = await a.authorsForFeed(db, three.id);
  const onFour = await a.authorsForFeed(db, four.id);
  assert.notEqual(onThree[0].id, onFour[0].id, 'a shared name is not a shared person');
  assert.notEqual(onThree[0].slug, onFour[0].slug, 'and they get their own pages');
});

test('a page crediting two people keeps its links off both of them', async () => {
  const feed = await seedFeed({ slug: 'pair', feedUrl: 'https://pair.example/feed.xml' });
  const pageLinks = [
    { network: 'fediverse', url: 'https://mastodon.social/@pairblog', handle: '@pairblog', source: 'page-link' },
  ];

  await storeCredits(
    db,
    { id: feed.id, feed_url: 'https://pair.example/feed.xml' },
    [
      { name: 'Lee Park', email: '', url: '', avatar: '', role: 'author', source: 'item-byline', confidence: 0.6 },
      { name: 'Nia Okafor', email: '', url: '', avatar: '', role: 'author', source: 'item-byline', confidence: 0.6 },
    ],
    pageLinks,
  );

  const found = await a.authorsForFeed(db, feed.id);
  assert.equal(found.length, 2);
  assert.ok(
    found.every((author) => author.links.length === 0),
    "a footer account belongs to one of them at most, and the page does not say which",
  );
});

test('two people stored in one batch each get their own links, not each other\'s', async () => {
  // The test for how the author id is resolved.
  //
  // `creditStatements` writes the whole credit set in one transaction, which it
  // can only do because it never reads an author id back into JS -- each link
  // row is written as `insert into author_links (...) select ?, id, ... from
  // authors where identity_key = ?`, resolving the id in SQL after the upsert
  // above it has run.
  //
  // The failure that would be invisible in a single-author test is binding the
  // wrong id: with two people in the same batch, an off-by-one or a stale
  // variable attaches Ada's homepage to Grace and nothing throws, nothing
  // duplicates, and the row counts all come out right. So this asserts on which
  // person each link actually landed on.
  const feed = await seedFeed({ slug: 'two-bylines', feedUrl: 'https://bylines.example/feed.xml' });

  await storeCredits(db, feed, [
    {
      name: 'Ada Byron',
      url: 'https://ada.example/',
      email: 'ada@ada.example',
      confidence: 0.9,
      source: 'feed',
      role: 'author',
    },
    {
      name: 'Grace Hopper',
      url: 'https://grace.example/',
      email: 'grace@grace.example',
      confidence: 0.9,
      source: 'feed',
      role: 'author',
    },
  ]);

  const { rows } = await db.execute({
    sql: `select a.name as person, l.url as link
          from author_links l join authors a on a.id = l.author_id
          join feed_authors fa on fa.author_id = a.id
          where fa.feed_id = ?
          order by a.name, l.url`,
    args: [String(feed.id)],
  });

  const byPerson = new Map();
  for (const r of rows) {
    const list = byPerson.get(String(r.person)) ?? [];
    list.push(String(r.link));
    byPerson.set(String(r.person), list);
  }

  // Asserted as "whose links are these" rather than as an exact list: the
  // credit pipeline also files a normalised form of a homepage, so the count is
  // an implementation detail. Which person each link hangs off is not.
  const ada = byPerson.get('Ada Byron') ?? [];
  const grace = byPerson.get('Grace Hopper') ?? [];

  assert.ok(ada.length >= 2 && grace.length >= 2, 'both people got their links');
  assert.ok(
    ada.every((url) => url.includes('ada')),
    `Ada has only her own links, got ${JSON.stringify(ada)}`,
  );
  assert.ok(
    grace.every((url) => url.includes('grace')),
    `and Grace only hers, got ${JSON.stringify(grace)}`,
  );
  assert.ok(ada.includes('mailto:ada@ada.example'), 'including her address');
  assert.ok(grace.includes('mailto:grace@grace.example'), 'and hers');

  // Both are filed against the feed, exactly once each.
  const linked = await db.execute({
    sql: 'select count(*) as n from feed_authors where feed_id = ?',
    args: [String(feed.id)],
  });
  assert.equal(Number(linked.rows[0].n), 2);
});

test('a credit re-stored unchanged writes nothing at all', async () => {
  // The guards on every conflict clause. Re-storing an identical credit is what
  // the crawler used to do on every single crawl of every feed -- three write
  // transactions to arrive at the rows already on file.
  const feed = await seedFeed({ slug: 'unchanged', feedUrl: 'https://unchanged.example/feed.xml' });
  const credit = [
    { name: 'Same Person', url: 'https://same.example/', confidence: 0.8, source: 'feed', role: 'author' },
  ];

  await storeCredits(db, feed, credit);

  const changes = async () => Number((await db.execute('select total_changes() as n')).rows[0].n);
  const before = await changes();

  await storeCredits(db, feed, credit);

  assert.equal((await changes()) - before, 0, 'the second store changed no rows');

  // And a credit that genuinely learns something still gets through.
  const richer = await changes();
  await storeCredits(db, feed, [{ ...credit[0], bio: 'Writes things.', confidence: 0.95 }]);
  assert.ok((await changes()) - richer > 0, 'a better credit is still written');
});

test('a blog with accounts but no byline keeps its accounts', async () => {
  const feed = await seedFeed({
    slug: 'unsigned',
    feedUrl: 'https://unsigned.example/feed.xml',
    siteUrl: 'https://unsigned.example/',
  });

  const fetcher = fakeFetch({
    'https://unsigned.example/': `<html><head><link rel="me" href="https://hachyderm.io/@unsigned"></head>
      <body><footer><a href="https://www.linkedin.com/in/someone">LinkedIn</a>
      <a href="https://x.com/unsigned">X</a></footer></body></html>`,
  });

  const result = await enrichFeedAuthors(db, feed, { fetch: fetcher, resolve: fakeResolve([]) });

  assert.equal(result.people, 0, 'nobody is named, and nobody is invented to hold the links');
  assert.ok(result.feedLinks > 0, 'this is a third of the small web; the accounts used to be thrown away');

  const links = await a.linksForFeed(db, feed.id);
  const networks = links.map((l) => l.network).sort();
  assert.deepEqual(networks, ['fediverse', 'linkedin', 'twitter']);

  assert.deepEqual(await a.authorsForFeed(db, feed.id), [], 'and still no fictional person');
});

test("a group blog's footer accounts go to the blog, not to each byline", async () => {
  const feed = await seedFeed({ slug: 'trio', feedUrl: 'https://trio.example/feed.xml' });
  const pageLinks = [
    { network: 'fediverse', url: 'https://mastodon.social/@trioblog', handle: '@trioblog', source: 'page-link' },
  ];

  await storeCredits(
    db,
    { id: feed.id, feed_url: 'https://trio.example/feed.xml' },
    [
      { name: 'Ida Bloom', email: '', url: '', avatar: '', role: 'author', source: 'item-byline', confidence: 0.6 },
      { name: 'Tomas Vega', email: '', url: '', avatar: '', role: 'author', source: 'item-byline', confidence: 0.6 },
    ],
    pageLinks,
  );

  const authorsOn = await a.authorsForFeed(db, feed.id);
  assert.equal(authorsOn.length, 2);
  assert.ok(
    authorsOn.every((person) => person.links.length === 0),
    'still not attributed to either of them — the page does not say which',
  );

  const onFeed = await a.linksForFeed(db, feed.id);
  assert.equal(onFeed.length, 1, 'but no longer discarded: it belongs to the publication');
  assert.equal(onFeed[0].network, 'fediverse');
});

test('storing the same feed links twice does not duplicate them', async () => {
  const feed = await seedFeed({ slug: 'twice', feedUrl: 'https://twice.example/feed.xml' });
  const links = [
    { network: 'fediverse', url: 'https://mastodon.social/@twice', handle: '@twice', source: 'page-link' },
  ];

  await storeCredits(db, { id: feed.id, feed_url: 'https://twice.example/feed.xml' }, [], links);
  await storeCredits(db, { id: feed.id, feed_url: 'https://twice.example/feed.xml' }, [], [
    { ...links[0], source: 'rel-me' },
  ]);

  const stored = await a.linksForFeed(db, feed.id);
  assert.equal(stored.length, 1, 'the pass re-runs over the directory every 90 days');
  assert.equal(stored[0].source, 'rel-me', 'and a better provenance replaces a weaker one');
});

test('the whole pass runs off a site that publishes an h-card and a Linktree', async () => {
  const feed = await seedFeed({
    slug: 'delta',
    feedUrl: 'https://delta.example/feed.xml',
    siteUrl: 'https://delta.example/',
  });

  const fetcher = fakeFetch({
    'https://delta.example/': `<html><head><link rel="me" href="https://hachyderm.io/@rin"></head>
      <body><div class="h-card"><a class="u-url p-name" href="https://delta.example/">Rin Tanaka</a></div>
      <footer><a href="https://linktr.ee/rin">elsewhere</a></footer></body></html>`,
    'https://linktr.ee/rin': `<html><body><a href="https://github.com/rintanaka">code</a></body></html>`,
  });

  const result = await enrichFeedAuthors(db, feed, { fetch: fetcher, resolve: fakeResolve([]) });

  assert.equal(result.people, 1);

  const [author] = await a.authorsForFeed(db, feed.id);
  assert.equal(author.name, 'Rin Tanaka');

  const networks = author.links.map((l) => l.network).sort();
  assert.deepEqual(
    networks,
    ['fediverse', 'github', 'linktree', 'website'],
    'the GitHub account was only reachable one hop through the links page',
  );

  const github = author.links.find((l) => l.network === 'github');
  assert.equal(github.source, 'linktree');
});

test('a feed nobody can be found on is still stamped, so the queue moves on', async () => {
  const feed = await seedFeed({
    slug: 'quiet',
    feedUrl: 'https://quiet.example/feed.xml',
    siteUrl: 'https://quiet.example/',
  });

  await enrichFeedAuthors(
    db,
    feed,
    { fetch: fakeFetch({ 'https://quiet.example/': '<html><body><p>Hello.</p></body></html>' }), resolve: fakeResolve([]) },
  );

  const row = await q.feedBySlug(db, 'quiet');
  assert.ok(row.authors_checked_at, 'a miss is a result; without the stamp the pass would loop on it forever');
  assert.deepEqual(await a.authorsForFeed(db, feed.id), []);
});

test('enrichDue takes the never-checked feeds first and stamps what it takes', async () => {
  const fresh = await seedFeed({
    slug: 'epsilon',
    feedUrl: 'https://epsilon.example/feed.xml',
    siteUrl: 'https://epsilon.example/',
  });

  // Large enough to take every feed the earlier tests seeded as well: they are
  // all active and none has been stamped, so they are ahead of this one in the
  // queue. Their pages are unstubbed, which makes them the misses this pass
  // has to get past.
  const result = await enrichDue(db, 50, {
    fetch: fakeFetch({
      'https://epsilon.example/': `<html><body><div class="h-card"><a class="u-url p-name" href="https://epsilon.example/">Omar Haddad</a></div></body></html>`,
    }),
    resolve: fakeResolve([]),
  });

  assert.ok(result.feeds > 0);

  const [author] = await a.authorsForFeed(db, fresh.id);
  assert.equal(author.name, 'Omar Haddad');

  // Everything the batch touched is now stamped, so a second identical run
  // finds nothing due rather than doing the same work again.
  const again = await a.dueForAuthors(db, 50, new Date(Date.now() - 86_400_000).toISOString());
  assert.equal(again.length, 0);
});

test('the rel="me" handshake marks a link verified when the profile answers', async () => {
  const feed = await seedFeed({
    slug: 'zeta',
    feedUrl: 'https://zeta.example/feed.xml',
    siteUrl: 'https://zeta.example/',
  });

  const fetcher = fakeFetch({
    'https://zeta.example/': `<html><head><link rel="me" href="https://hachyderm.io/@pat"></head>
      <body><div class="h-card"><a class="u-url p-name" href="https://zeta.example/">Pat Nolan</a></div></body></html>`,
    'https://hachyderm.io/@pat': `<html><head><link rel="me" href="https://zeta.example/"></head></html>`,
  });

  const result = await enrichFeedAuthors(
    db,
    feed,
    { fetch: fetcher, resolve: fakeResolve([]), verify: true },
  );

  assert.equal(result.verified, 1);

  const [author] = await a.authorsForFeed(db, feed.id);
  const fedi = author.links.find((l) => l.network === 'fediverse');
  assert.equal(fedi.verified, true);
});

test('the stats say how far the pass has got and how many people can be reached', async () => {
  const stats = await a.authorStats(db);
  assert.ok(stats.authors > 0);
  assert.ok(stats.feedsChecked > 0);
  assert.ok(stats.reachable > 0, 'an author with an email or a social account is a reachable one');
  assert.ok(stats.links >= stats.reachable, 'every reachable author is reachable by at least one link');
  assert.ok(stats.reachable <= stats.authors);
});
