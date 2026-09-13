import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q, webrings } from '../index.js';

/**
 * Rings and their members, against a file database.
 *
 * The property everything else depends on is that a member's position is
 * assigned once. A topic's feeds come back in a different order on every
 * crawl, so if seeding ever re-ordered, a member's neighbours would change
 * under them and every pasted "next" link would point somewhere new.
 */

let dir;
let db;
/** @type {Record<string, { id: string, slug: string }>} */
const feeds = {};

/**
 * @param {string} slug
 * @param {{ site?: string|null, status?: string, topics?: string[], created?: string }} [opts]
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
  if (opts.created) {
    await db.execute({ sql: 'update feeds set created_at = ? where id = ?', args: [opts.created, row.id] });
  }
  for (const topic of opts.topics ?? ['physics']) {
    await db.execute({
      sql: 'insert into feed_keywords (feed_id, slug, keyword, words, count, source) values (?, ?, ?, ?, ?, ?)',
      args: [row.id, topic, topic === 'physics' ? 'Physics' : topic, 1, 3, 'category'],
    });
  }
  feeds[slug] = row;
  return row;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-webrings-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);

  // Admission order is deliberately not alphabetical and not the order the
  // topic strength would give, so the test can tell the three apart.
  await feed('carol', { created: '2026-01-03T00:00:00.000Z' });
  await feed('alice', { created: '2026-01-01T00:00:00.000Z' });
  await feed('bob', { created: '2026-01-02T00:00:00.000Z' });
  await feed('nosite', { created: '2026-01-01T12:00:00.000Z', site: null });
  await feed('dead', { created: '2026-01-01T13:00:00.000Z', status: 'dead' });
  await feed('other', { created: '2026-01-01T14:00:00.000Z', topics: ['chemistry'] });
  await q.refreshTopics(db, 1);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a topic ring is seeded in admission order, from the feeds that can link', async () => {
  const result = await webrings.seedTopicRing(db, 'physics');
  assert.deepEqual(result, { slug: 'physics', created: true, added: 3, total: 3 });

  const ring = await webrings.ringBySlug(db, 'physics');
  assert.ok(ring);
  assert.equal(ring.title, 'Physics', 'the most-used spelling, as the topic page says it');
  assert.equal(ring.kind, 'topic');
  assert.equal(ring.topic_slug, 'physics');
  assert.equal(ring.accepts, null, 'a topic ring accepts everybody');
  assert.equal(ring.member_count, 3);
  assert.equal(ring.active_count, 0, 'nobody is active before a check');

  const members = await webrings.membersOf(db, 'physics');
  assert.deepEqual(members.map((m) => [m.member_slug, m.position, m.status]), [
    ['alice', 0, 'pending'],
    ['bob', 1, 'pending'],
    ['carol', 2, 'pending'],
  ]);
  assert.equal(members[0].title, 'Alice');
  assert.equal(members[0].feed_url, 'https://alice.example/feed.xml');
  assert.equal(members[0].language, 'en');
  assert.equal(members[0].site_url, 'https://alice.example/');
  assert.ok(!members.some((m) => m.member_slug === 'nosite'), 'a feed with no site has nothing to link from');
  assert.ok(!members.some((m) => m.member_slug === 'dead'), 'and a dead one has no page to put a link on');
});

test('re-seeding changes nothing, and a new feed joins at the end', async () => {
  const again = await webrings.seedTopicRing(db, 'physics');
  assert.deepEqual(again, { slug: 'physics', created: false, added: 0, total: 3 });

  // A feed older than every member, which strength or date order would put
  // first. It goes last: positions are assigned once.
  await feed('zed', { created: '2025-06-01T00:00:00.000Z' });
  const grown = await webrings.seedTopicRing(db, 'physics');
  assert.deepEqual(grown, { slug: 'physics', created: false, added: 1, total: 4 });

  const members = await webrings.membersOf(db, 'physics');
  assert.deepEqual(members.map((m) => [m.member_slug, m.position]), [
    ['alice', 0],
    ['bob', 1],
    ['carol', 2],
    ['zed', 3],
  ]);
});

test('the limit caps the ring and a full ring stays full', async () => {
  await feed('young', { created: '2026-02-01T00:00:00.000Z' });
  const capped = await webrings.seedTopicRing(db, 'physics', { limit: 4 });
  assert.deepEqual(capped, { slug: 'physics', created: false, added: 0, total: 4 });
  const later = await webrings.seedTopicRing(db, 'physics', { limit: 5 });
  assert.deepEqual(later, { slug: 'physics', created: false, added: 1, total: 5 });
  assert.equal((await webrings.membersOf(db, 'physics')).at(-1)?.member_slug, 'young');
});

test('the top topics are the most covered ones with enough feeds to ring', async () => {
  const top = await webrings.topRingTopics(db, { count: 5, minFeeds: 1 });
  assert.equal(top[0].slug, 'physics');
  assert.equal(await webrings.topicRingSize(db, 'physics'), 5, 'the feeds that can link, distinct');
  assert.equal(await webrings.topicRingSize(db, 'chemistry'), 1);
  assert.equal(await webrings.topicRingSize(db, 'nothing'), 0);
  assert.equal(await webrings.topicRingSize(db, 'physics', { cap: 3 }), 3, 'a capped count stops at the cap');
  assert.equal(await webrings.topicRingSize(db, 'chemistry', { cap: 3 }), 1, 'and is exact under it');
});

test('a check records status and stamp, and a descriptor sets made_by', async () => {
  const alice = feeds.alice.id;
  await webrings.recordCheck(db, 'physics', alice, {
    status: 'active',
    checkedAt: '2026-09-01T00:00:00.000Z',
    madeBy: 'human',
    disclosure: 'none',
    descriptorUrl: 'https://alice.example/.well-known/openwebring.json',
  });
  let [m] = await webrings.membersOf(db, 'physics');
  assert.equal(m.status, 'active');
  assert.equal(m.checked_at, '2026-09-01T00:00:00.000Z');
  assert.equal(m.made_by, 'human');
  assert.equal(m.made_by_source, 'descriptor');
  assert.equal(m.disclosure, 'none');
  assert.equal(m.descriptor_url, 'https://alice.example/.well-known/openwebring.json');
  assert.equal(m.position, 0, 'a check never moves anybody');

  // A later pass whose descriptor says nothing keeps what it said before.
  await webrings.recordCheck(db, 'physics', alice, { status: 'active', checkedAt: '2026-09-08T00:00:00.000Z' });
  [m] = await webrings.membersOf(db, 'physics');
  assert.equal(m.made_by, 'human');
  assert.equal(m.descriptor_url, 'https://alice.example/.well-known/openwebring.json');

  // And a descriptor that changes its mind is believed.
  await webrings.recordCheck(db, 'physics', alice, { status: 'active', madeBy: 'both' });
  [m] = await webrings.membersOf(db, 'physics');
  assert.equal(m.made_by, 'both');

  // Junk never reaches the column.
  await webrings.recordCheck(db, 'physics', alice, { status: 'active', madeBy: 'person' });
  [m] = await webrings.membersOf(db, 'physics');
  assert.equal(m.made_by, 'both');

  const ring = await webrings.ringBySlug(db, 'physics');
  assert.equal(ring?.active_count, 1);
  assert.ok(ring && ring.updated >= '2026-09-08', 'the ring is as fresh as its newest check');
});

test('the owner\'s word is never overwritten by a descriptor pass', async () => {
  const bob = feeds.bob.id;
  const set = await webrings.setMemberMadeBy(db, 'physics', bob, { madeBy: 'human', disclosure: 'none', source: 'owner' });
  assert.equal(set?.made_by, 'human');
  assert.equal(set?.made_by_source, 'owner');

  await webrings.recordCheck(db, 'physics', bob, { status: 'active', madeBy: 'ai', disclosure: 'ai-generated' });
  const [, m] = await webrings.membersOf(db, 'physics');
  assert.equal(m.member_slug, 'bob');
  assert.equal(m.status, 'active', 'the status is still the check\'s to set');
  assert.equal(m.made_by, 'human', 'the owner said human, the crawler read ai, the owner wins');
  assert.equal(m.disclosure, 'none');
  assert.equal(m.made_by_source, 'owner');

  const admin = await webrings.setMemberMadeBy(db, 'physics', bob, { madeBy: null, source: 'admin' });
  assert.equal(admin?.made_by, null, 'null clears');
  assert.equal(admin?.made_by_source, 'admin');
  await webrings.recordCheck(db, 'physics', bob, { status: 'inactive', madeBy: 'ai' });
  assert.equal((await webrings.memberBySlug(db, 'physics', 'bob'))?.made_by, null, 'and an admin\'s clearing holds too');
  assert.equal((await webrings.memberBySlug(db, 'physics', 'bob'))?.status, 'inactive');
});

test('members are due oldest verdict first, never-checked before anyone', async () => {
  const due = await webrings.membersDueForCheck(db, 10);
  assert.deepEqual(
    due.map((m) => m.member_slug),
    ['carol', 'zed', 'young', 'alice', 'bob'],
    'the three never checked in joining order, then alice (checked 09-01 by stamp), then bob (checked now)',
  );
  // Alice's last two checks and bob's carried no stamp, so they are "now":
  // both fall inside the cutoff and only the never-checked are due.
  const before = await webrings.membersDueForCheck(db, 10, { before: '2026-09-02T00:00:00.000Z' });
  assert.deepEqual(before.map((m) => m.member_slug), ['carol', 'zed', 'young'], 'a recent verdict stands');
  const all = await webrings.membersDueForCheck(db, 10, { before: null });
  assert.equal(all.length, 5, 'no cutoff is everybody');
  assert.equal((await webrings.membersDueForCheck(db, 2)).length, 2, 'bounded');
});

test('a ring lists once, by size, and a private one not at all', async () => {
  await webrings.seedTopicRing(db, 'chemistry');
  await db.execute({ sql: "insert into rings (slug, title, kind, public, created_at, updated_at) values ('secret', 'Secret', 'curated', 0, 'x', 'x')" });

  const rings = await webrings.listRings(db);
  assert.deepEqual(rings.map((r) => r.slug), ['physics', 'chemistry']);
  assert.equal(rings[0].member_count, 5);
  assert.equal(rings[1].member_count, 1);
  assert.deepEqual((await webrings.listRings(db, { includePrivate: true })).map((r) => r.slug), ['physics', 'chemistry', 'secret']);
  assert.equal(await webrings.ringBySlug(db, 'nothing'), null);
  assert.equal(await webrings.memberBySlug(db, 'physics', 'nobody'), null);
});

test('a ring goes when its topic does not, and a member goes with its feed', async () => {
  await db.execute({ sql: 'delete from feeds where id = ?', args: [feeds.young.id] });
  assert.equal((await webrings.membersOf(db, 'physics')).length, 4, 'cascade');
  await db.execute({ sql: "delete from rings where slug = 'chemistry'" });
  const { rows } = await db.execute({ sql: "select count(*) as n from ring_members where ring_slug = 'chemistry'", args: [] });
  assert.equal(Number(rows[0].n), 0);
});

test('ring topics come from what publishers file under, never the commonest word, and a stale ring goes', async () => {
  // "one" is the commonest phrase in every feed's prose (source content); "de"
  // is a two-letter tag. Neither is a subject.
  for (const who of ['carol', 'alice', 'bob', 'other']) {
    await db.execute({
      sql: 'insert or ignore into feed_keywords (feed_id, slug, keyword, words, count, source) values (?, ?, ?, ?, ?, ?)',
      args: [feeds[who].id, 'one', 'one', 1, 900, 'content'],
    });
    await db.execute({
      sql: 'insert or ignore into feed_keywords (feed_id, slug, keyword, words, count, source) values (?, ?, ?, ?, ?, ?)',
      args: [feeds[who].id, 'de', 'de', 1, 50, 'category'],
    });
  }
  await q.refreshTopics(db, 1);

  const top = await webrings.topRingTopics(db, { count: 5, minFeeds: 1 });
  assert.deepEqual(
    top.map((t) => t.slug),
    ['physics', 'chemistry'],
    'physics has three linkable feeds filed under it, chemistry one; one is prose, de is too short',
  );
  assert.equal(top[0].feed_count, await webrings.topicRingSize(db, 'physics'), 'counted on the feeds a ring can use, not the rollup');

  // A ring made under the old ranking, with nobody active in it, is dropped
  // when its topic no longer qualifies; a qualifying ring stays.
  await webrings.seedTopicRing(db, 'one');
  assert.ok(await webrings.ringBySlug(db, 'one'));
  const gone = await webrings.dropStaleTopicRings(db, ['physics', 'chemistry'], { keepActive: 1 });
  assert.deepEqual(gone, ['one']);
  assert.equal(await webrings.ringBySlug(db, 'one'), null);
  assert.ok(await webrings.ringBySlug(db, 'physics'), 'the qualifying ring is untouched');
});
