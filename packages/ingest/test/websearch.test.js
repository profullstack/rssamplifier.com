import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q, authors as a } from '@rssamplifier/db';

import { storeCredits } from '../src/enrich.js';
import { linksFromSearch, searchDue, searchesFor, worthSearching } from '../src/websearch.js';

// This is the only pass that spends money, so what is tested is mostly what it
// refuses to do: search for somebody it is not sure is a person, search for
// somebody already reachable, spend past the budget, or believe a result.

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-search-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('the gate refuses everyone a credit would be wasted on', () => {
  const ok = { name: 'Jane Doe', confidence: 0.85, feedCount: 1, linkCount: 0 };
  assert.equal(worthSearching(ok), true);

  // A name we only half-believe would put the results on a person who may not
  // exist.
  assert.equal(worthSearching({ ...ok, confidence: 0.6 }), false);
  // One word returns the world.
  assert.equal(worthSearching({ ...ok, name: 'Jane' }), false);
  // Already reachable: the budget exists for the people who are not.
  assert.equal(worthSearching({ ...ok, linkCount: 2 }), false);
  assert.equal(worthSearching({}), false);
});

test('a query is scoped by the domain, which is what tells two namesakes apart', () => {
  const queries = searchesFor({ name: 'Jane Doe', site: 'https://www.jane.example/blog' });
  assert.ok(queries.every((s) => s.q.includes('jane.example')));
  assert.ok(queries.some((s) => s.q === '"Jane Doe" jane.example site:linkedin.com/in'));

  // Without a site there is nothing to scope by, and the name has to stand alone.
  const bare = searchesFor({ name: 'Jane Doe' });
  assert.equal(bare[0].q, '"Jane Doe" site:linkedin.com/in');
  assert.deepEqual(searchesFor({ name: '' }), []);
});

test('only real profiles survive, and none of them is evidence', () => {
  const links = linksFromSearch('linkedin', {
    organic_results: [
      { link: 'https://www.linkedin.com/in/janedoe' },
      // A company page is not a person, and a post is not an account.
      { link: 'https://www.linkedin.com/company/acme' },
      { link: 'https://www.linkedin.com/posts/janedoe_hiring-activity-123' },
      // The right shape on the wrong network for this query.
      { link: 'https://github.com/janedoe' },
    ],
  });

  assert.deepEqual(
    links.map((l) => l.url),
    ['https://www.linkedin.com/in/janedoe'],
  );
  assert.equal(links[0].source, 'web-search');
  assert.equal(links[0].verified, false, 'a search engine cannot verify anything');
});

test('a malformed or empty response yields nothing rather than throwing', () => {
  assert.deepEqual(linksFromSearch('github', null), []);
  assert.deepEqual(linksFromSearch('github', {}), []);
  assert.deepEqual(linksFromSearch('github', { organic_results: 'no' }), []);
});

/** Seed one author with no way to reach them. */
async function seedUnreachable(slug, name) {
  const feed = await q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example/feed.xml`,
    site_url: `https://${slug}.example/`,
    title: name,
    categories: [],
    kind: 'blog',
    status: 'active',
  });

  await storeCredits(
    db,
    { id: feed.id, feed_url: `https://${slug}.example/feed.xml` },
    [
      {
        name,
        email: '',
        url: '',
        avatar: '',
        role: 'author',
        source: 'atom-feed-author',
        confidence: 0.85,
      },
    ],
  );

  return feed;
}

test('the budget is read from the ledger, so a restart cannot reset it', async () => {
  await seedUnreachable('ledger-blog', 'Jane Ledger');

  // Everything already spent this period.
  await a.recordAuthorSearch(db, { authorId: null, queries: 25, found: 0 });

  let called = 0;
  const result = await searchDue(db, {
    apiKey: 'test-key',
    monthlyBudget: 25,
    fetch: async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });

  assert.equal(called, 0, 'the allowance is gone, so nothing may be bought');
  assert.equal(result.spent, 0);
});

test('spending stops at the budget even when more people qualify', async () => {
  const fresh = await mkdtemp(join(tmpdir(), 'rssamp-budget-'));
  const db2 = connect({ url: `file:${join(fresh, 'b.db')}` });
  await migrate(db2);

  for (const [slug, name] of [
    ['aa-blog', 'Anna Aardvark'],
    ['bb-blog', 'Bob Bison'],
    ['cc-blog', 'Cara Cat'],
  ]) {
    const feed = await q.insertFeed(db2, {
      slug,
      feed_url: `https://${slug}.example/feed.xml`,
      site_url: `https://${slug}.example/`,
      title: name,
      categories: [],
      kind: 'blog',
      status: 'active',
    });
    await storeCredits(
      db2,
      { id: feed.id, feed_url: `https://${slug}.example/feed.xml` },
      [{ name, email: '', url: '', avatar: '', role: 'author', source: 'atom-feed-author', confidence: 0.85 }],
    );
  }

  let called = 0;
  const result = await searchDue(db2, {
    apiKey: 'test-key',
    monthlyBudget: 3,
    perAuthor: 2,
    batchSize: 10,
    fetch: async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => ({ organic_results: [] }) };
    },
  });

  assert.equal(called, 3, `bought ${called} queries against a budget of 3`);
  assert.equal(result.spent, 3);

  // And the ledger agrees with what was bought, which is the number that has to
  // match the invoice.
  assert.equal(await a.searchSpendSince(db2, a.billingPeriodStart()), 3);

  await rm(fresh, { recursive: true, force: true });
});

test('an exhausted account stops the batch instead of being asked again', async () => {
  const fresh = await mkdtemp(join(tmpdir(), 'rssamp-402-'));
  const db2 = connect({ url: `file:${join(fresh, 'c.db')}` });
  await migrate(db2);

  const feed = await q.insertFeed(db2, {
    slug: 'dd-blog',
    feed_url: 'https://dd-blog.example/feed.xml',
    site_url: 'https://dd-blog.example/',
    title: 'Dee Blogger',
    categories: [],
    kind: 'blog',
    status: 'active',
  });
  await storeCredits(
    db2,
    { id: feed.id, feed_url: 'https://dd-blog.example/feed.xml' },
    [{ name: 'Dee Blogger', email: '', url: '', avatar: '', role: 'author', source: 'atom-feed-author', confidence: 0.85 }],
  );

  let called = 0;
  await searchDue(db2, {
    apiKey: 'test-key',
    monthlyBudget: 50,
    perAuthor: 4,
    fetch: async () => {
      called += 1;
      // The provider's documented answer for an empty account.
      return { ok: false, status: 402, json: async () => ({}) };
    },
  });

  assert.equal(called, 1, '402 will not change before the reset, so asking twice is waste');

  await rm(fresh, { recursive: true, force: true });
});

test('nothing is bought without a key, a budget and the switch', async () => {
  let called = 0;
  const fetcher = async () => {
    called += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  assert.deepEqual(await searchDue(db, { apiKey: '', monthlyBudget: 100, fetch: fetcher }), {
    people: 0,
    links: 0,
    spent: 0,
    remaining: 0,
  });
  await searchDue(db, { apiKey: 'k', monthlyBudget: 0, fetch: fetcher });
  assert.equal(called, 0);
});

test('the billing period follows the provider, which resets on the 13th', () => {
  // A calendar month would let the allowance be spent twice across a reset.
  assert.equal(a.billingPeriodStart(new Date('2026-08-19T00:00:00Z')), '2026-08-13T00:00:00.000Z');
  // Before the 13th, the period began the month before.
  assert.equal(a.billingPeriodStart(new Date('2026-08-02T00:00:00Z')), '2026-07-13T00:00:00.000Z');
});
