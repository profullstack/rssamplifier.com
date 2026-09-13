import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q, accounts, authors, profiles } from '../index.js';

let dir;
let db;
let ada;
let podcast;
let blog;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-profiles-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);

  podcast = await q.insertFeed(db, {
    slug: 'analytical-engine',
    feed_url: 'https://ada.example/podcast/feed.xml',
    site_url: 'https://ada.example/podcast',
    title: 'The Analytical Engine',
    kind: 'podcast',
    status: 'active',
  });
  blog = await q.insertFeed(db, {
    slug: 'ada-blog',
    feed_url: 'https://ada.example/feed.xml',
    site_url: 'https://ada.example/',
    title: 'Notes',
    kind: 'blog',
    status: 'active',
  });
  await q.upsertItems(db, String(podcast.id), [
    { guid: 'e2', title: 'Episode 2', publishedAt: '2025-03-01T00:00:00.000Z' },
    { guid: 'e1', title: 'Episode 1', publishedAt: '2024-11-15T00:00:00.000Z' },
  ]);
  for (const [feed, rows] of [
    [podcast, [['history', 4, 'category'], ['mathematics', 2, 'content']]],
    [blog, [['mathematics', 9, 'content']]],
  ]) {
    for (const [keyword, count, source] of rows) {
      await db.execute({
        sql: 'insert into feed_keywords (feed_id, slug, keyword, words, count, source) values (?, ?, ?, ?, ?, ?)',
        args: [String(feed.id), keyword, keyword, 1, count, source],
      });
    }
  }

  ada = await authors.upsertAuthor(db, {
    identityKey: 'https://ada.example',
    slug: 'ada-lovelace',
    name: 'Ada Lovelace',
    normName: 'ada lovelace',
    siteUrl: 'https://ada.example',
    email: 'ada@example.com',
    confidence: 0.9,
  });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('no row means no profile: the generated file stands', async () => {
  assert.equal(await profiles.profileForAuthor(db, ada.id), null);
});

test('the Topics inputs come from the feeds themselves', async () => {
  const topics = await profiles.keywordsForFeeds(db, [String(podcast.id), String(blog.id)]);
  assert.deepEqual(
    topics.get(String(podcast.id)),
    [{ keyword: 'history', source: 'category' }, { keyword: 'mathematics', source: 'content' }],
    'category first, then by count',
  );
  assert.deepEqual(topics.get(String(blog.id)), [{ keyword: 'mathematics', source: 'content' }]);
  assert.equal((await profiles.keywordsForFeeds(db, [])).size, 0);
});

test('a claim records who, how and when; a second claim keeps the first stamp', async () => {
  const user = await accounts.findOrCreateUser(db, 'ada@example.com');
  const claimed = await profiles.claimProfile(db, ada.id, { userId: String(user.id), method: 'email' });
  assert.equal(claimed.owner_user_id, String(user.id));
  assert.equal(claimed.claim_method, 'email');
  assert.ok(claimed.claimed_at);
  assert.equal(claimed.public, true);
  assert.deepEqual(claimed.overrides, {});

  const again = await profiles.claimProfile(db, ada.id, { principal: 'oa:abc', method: 'linkback' });
  assert.equal(again.claimed_at, claimed.claimed_at, 'the first claim stamp survives');
  assert.equal(again.claim_method, 'email');
  assert.equal(again.owner_user_id, String(user.id), 'the account stays');
  assert.equal(again.owner_principal, 'oa:abc', 'a second credential is added beside it');
});

test('saving stores the overlay and the switch, and keeps the claim', async () => {
  const saved = await profiles.saveProfile(db, ada.id, {
    overrides: { headline: 'Countess, programmer.', sections: { guest: '- **Available**: yes' } },
    public: false,
  });
  assert.equal(saved.overrides.headline, 'Countess, programmer.');
  assert.equal(saved.public, false);
  assert.equal(saved.claim_method, 'email');

  const flipped = await profiles.saveProfile(db, ada.id, { public: true });
  assert.equal(flipped.public, true);
  assert.equal(flipped.overrides.headline, 'Countess, programmer.', 'a switch alone leaves the overlay');

  const user = await accounts.userByEmail(db, 'ada@example.com');
  const mine = await profiles.profilesForUser(db, String(user.id));
  assert.deepEqual(mine.map((p) => p.slug), ['ada-lovelace']);
});

test('a bad overrides column reads as an empty overlay rather than a crash', async () => {
  await db.execute({ sql: "update author_profiles set overrides = '{not json' where author_id = ?", args: [ada.id] });
  const row = await profiles.profileForAuthor(db, ada.id);
  assert.deepEqual(row.overrides, {});
});
