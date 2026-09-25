import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { accounts, q, webrings } from '../index.js';
import { connectTest } from '../src/testdb.js';

/**
 * Likes are on or off per account; events are a log; the top rings are the
 * ones people like, then the ones whose sites link back.
 */

let db;
let alice;
let bob;

before(async () => {
  db = await connectTest();
  alice = await accounts.findOrCreateUser(db, 'alice@example.com');
  bob = await accounts.findOrCreateUser(db, 'bob@example.com');
  const feed = await q.insertFeed(db, {
    slug: 'carol',
    feed_url: 'https://carol.example/feed.xml',
    site_url: 'https://carol.example/',
    title: 'Carol',
    kind: 'blog',
    status: 'active',
    language: 'en',
  });
  await webrings.createRing(db, { slug: 'quiet', title: 'Quiet', ownerId: String(alice.id) });
  await webrings.createRing(db, { slug: 'loud', title: 'Loud', ownerId: String(alice.id) });
  await webrings.addRingMembers(db, 'loud', [{ id: feed.id, slug: 'carol', site_url: 'https://carol.example/' }]);
});

after(async () => {
  db.close();
});

test('a like is on or off per account, and counted once', async () => {
  assert.equal(await webrings.ringLiked(db, 'loud', String(alice.id)), false);
  assert.equal(await webrings.likeRing(db, 'loud', String(alice.id), true), true);
  assert.equal(await webrings.likeRing(db, 'loud', String(alice.id), true), true);
  assert.equal(await webrings.ringLiked(db, 'loud', String(alice.id)), true);
  assert.equal(await webrings.ringLikes(db, 'loud'), 1);

  await webrings.likeRing(db, 'loud', String(bob.id), true);
  assert.equal(await webrings.ringLikes(db, 'loud'), 2);
  assert.deepEqual(await webrings.ringLikeCounts(db, ['loud', 'quiet']), { loud: 2 });

  assert.equal(await webrings.likeRing(db, 'loud', String(bob.id), false), false);
  assert.equal(await webrings.ringLikes(db, 'loud'), 1);

  // A topic that is still a computed ring can be liked all the same.
  await webrings.likeRing(db, 'physics', String(bob.id), true);
  assert.equal(await webrings.ringLikes(db, 'physics'), 1);
});

test('the top rings are the liked ones first, then the linking ones', async () => {
  const top = await webrings.topRings(db, 5);
  assert.deepEqual(
    top.map((r) => [r.slug, r.likes]),
    [
      ['loud', 1],
      ['quiet', 0],
    ],
  );
});

test('events are a log the leaderboard can read back in order', async () => {
  await webrings.recordRingEvent(db, { kind: 'view', ringSlug: 'loud', memberSlug: 'carol', userId: String(bob.id) });
  await webrings.recordRingEvent(db, { kind: 'share', ringSlug: 'loud', userId: null });
  await webrings.recordRingEvent(db, { kind: 'make', ringSlug: 'quiet', userId: String(alice.id) });
  await assert.rejects(() => webrings.recordRingEvent(db, { kind: 'dance', ringSlug: 'loud' }), /unknown ring event/);

  const rows = await webrings.ringEventsSince(db, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(
    rows.map((r) => [r.kind, r.ring_slug, r.member_slug, r.user_id === null ? null : 'someone']),
    [
      ['view', 'loud', 'carol', 'someone'],
      ['share', 'loud', null, null],
      ['make', 'quiet', null, 'someone'],
    ],
  );
  assert.deepEqual(await webrings.ringEventsSince(db, '2999-01-01T00:00:00.000Z'), []);

  assert.deepEqual(await webrings.ringNames(db, ['loud', 'nowhere']), { loud: 'Loud', nowhere: 'nowhere' });
});
