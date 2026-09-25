import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { q, webrings } from '../index.js';
import { connectTest } from '../src/testdb.js';

/**
 * Every topic is a ring, and a ring somebody makes on the site.
 *
 * The computed ring is the topic's feeds in the topic's order with nothing
 * written; the owned ring is rows with an owner, members appended in the
 * order given and never re-numbered.
 */

let db;
/** @type {Record<string, { id: string, slug: string }>} */
const feeds = {};

/**
 * @param {string} slug
 * @param {{ site?: string|null, status?: string, topics?: string[], count?: number }} [opts]
 */
async function feed(slug, opts = {}) {
  const row = await q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example/feed.xml`,
    site_url: opts.site === undefined ? `https://${slug}.example/` : opts.site,
    title: slug[0].toUpperCase() + slug.slice(1),
    kind: 'blog',
    status: opts.status ?? 'active',
    language: 'en',
  });
  for (const topic of opts.topics ?? ['physics']) {
    await db.execute({
      sql: 'insert into feed_keywords (feed_id, slug, keyword, words, count, source) values (?, ?, ?, ?, ?, ?)',
      args: [row.id, topic, topic === 'physics' ? 'Physics' : topic, 1, opts.count ?? 3, 'category'],
    });
  }
  feeds[slug] = row;
  return row;
}

before(async () => {
  db = await connectTest();
  await feed('carol', { count: 3 });
  await feed('alice', { count: 9 });
  await feed('bob', { count: 6 });
  await feed('nosite', { site: null });
  await feed('dead', { status: 'dead' });
  await feed('other', { topics: ['chemistry'] });
  await q.refreshTopics(db, 1);
});

after(async () => {
  db.close();
});

test('a topic is a ring without a row: its feeds, in its order, all pending', async () => {
  const preview = await webrings.topicRingPreview(db, 'physics');
  assert.ok(preview);
  assert.equal(preview.ring.virtual, true);
  assert.equal(preview.ring.kind, 'topic');
  assert.equal(preview.ring.topic_slug, 'physics');
  assert.equal(preview.ring.title, 'Physics');
  assert.equal(preview.ring.owner_id, null);
  assert.deepEqual(
    preview.members.map((m) => [m.member_slug, m.position, m.status, m.made_by]),
    [
      ['alice', 1, 'pending', null],
      ['bob', 2, 'pending', null],
      ['carol', 3, 'pending', null],
    ],
  );
  assert.equal(preview.ring.member_count, 3);
  assert.equal(preview.members[0].site_url, 'https://alice.example/');
  assert.equal(preview.members[0].title, 'Alice');

  // Nothing was written.
  assert.equal(await webrings.ringBySlug(db, 'physics'), null);
});

test('a topic nobody with a site writes about is not a ring', async () => {
  assert.equal(await webrings.topicRingPreview(db, 'nothing-here'), null);
});

test('a ring somebody makes has an owner and is public at once', async () => {
  const ring = await webrings.createRing(db, {
    slug: 'my-picks',
    title: 'My picks',
    description: 'Three blogs.',
    ownerId: 'user-1',
  });
  assert.ok(ring);
  assert.equal(ring.owner_id, 'user-1');
  assert.equal(ring.kind, 'curated');
  assert.equal(ring.public, true);

  // The slug is taken now.
  assert.equal(
    await webrings.createRing(db, { slug: 'my-picks', title: 'Again', ownerId: 'user-2' }),
    null,
  );
  assert.equal((await webrings.ringBySlug(db, 'my-picks'))?.owner_id, 'user-1');

  const mine = await webrings.ringsOwnedBy(db, 'user-1');
  assert.deepEqual(
    mine.map((r) => r.slug),
    ['my-picks'],
  );
  assert.deepEqual(await webrings.ringsOwnedBy(db, 'user-2'), []);
});

test('members append in the order given, keep their numbers, and can be taken out', async () => {
  const added = await webrings.addRingMembers(db, 'my-picks', [
    { id: feeds.carol.id, slug: 'carol', site_url: 'https://carol.example/' },
    { id: feeds.alice.id, slug: 'alice', site_url: 'https://alice.example/' },
    { id: feeds.carol.id, slug: 'carol', site_url: 'https://carol.example/' },
  ]);
  assert.equal(added, 2);

  const more = await webrings.addRingMembers(db, 'my-picks', [
    { id: feeds.alice.id, slug: 'alice', site_url: 'https://alice.example/' },
    { id: feeds.bob.id, slug: 'bob', site_url: 'https://bob.example/' },
  ]);
  assert.equal(more, 1);

  let members = await webrings.membersOf(db, 'my-picks');
  assert.deepEqual(
    members.map((m) => [m.member_slug, m.position]),
    [
      ['carol', 1],
      ['alice', 2],
      ['bob', 3],
    ],
  );

  assert.equal(await webrings.removeRingMember(db, 'my-picks', 'alice'), true);
  assert.equal(await webrings.removeRingMember(db, 'my-picks', 'alice'), false);
  members = await webrings.membersOf(db, 'my-picks');
  // Bob keeps his number: positions are never rewritten.
  assert.deepEqual(
    members.map((m) => [m.member_slug, m.position]),
    [
      ['carol', 1],
      ['bob', 3],
    ],
  );

  await webrings.updateRing(db, 'my-picks', { title: 'Our picks', description: null });
  const ring = await webrings.ringBySlug(db, 'my-picks');
  assert.equal(ring?.title, 'Our picks');
  assert.equal(ring?.description, null);
  assert.equal(ring?.member_count, 2);
});

test('what somebody types for a member resolves to the feed in the directory', async () => {
  const bySlug = await webrings.feedForRingInput(db, 'alice');
  assert.equal(bySlug?.slug, 'alice');
  assert.equal((await webrings.feedForRingInput(db, '/alice/'))?.slug, 'alice');

  assert.equal((await webrings.feedForRingInput(db, 'https://bob.example/'))?.slug, 'bob');
  assert.equal((await webrings.feedForRingInput(db, 'https://bob.example'))?.slug, 'bob');
  assert.equal((await webrings.feedForRingInput(db, 'https://carol.example/feed.xml'))?.slug, 'carol');

  assert.equal(await webrings.feedForRingInput(db, 'https://nobody.example/'), null);
  assert.equal(await webrings.feedForRingInput(db, 'dead'), null);
  assert.equal(await webrings.feedForRingInput(db, ''), null);
  assert.equal(await webrings.feedForRingInput(db, 'not a url at all'), null);
});
