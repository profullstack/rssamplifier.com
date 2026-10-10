import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { webrings } from '../index.js';
import { connectTest } from '../src/testdb.js';

/**
 * Votes are anonymous and throttled: one per voter per site per day, and a
 * cap per voter per hour across every site.
 */

let db;

before(async () => {
  db = await connectTest();
});

after(async () => {
  await db?.close();
});

const NOON = new Date('2026-10-10T12:00:00Z');
const at = (minutes) => new Date(NOON.getTime() + minutes * 60_000);

test('one vote per voter per site per day', async () => {
  const vote = { ringSlug: 'r1', memberSlug: 'alpha', voter: 'v1' };
  assert.equal(await webrings.castRingVote(db, { ...vote, now: NOON }), 'voted');
  assert.equal(await webrings.castRingVote(db, { ...vote, now: at(5) }), 'already');
  assert.equal(await webrings.castRingVote(db, { ...vote, voter: 'v2', now: at(5) }), 'voted');
  assert.equal(await webrings.castRingVote(db, { ...vote, memberSlug: 'beta', now: at(5) }), 'voted');
  assert.equal(await webrings.castRingVote(db, { ...vote, now: at(24 * 60) }), 'voted', 'a new day is a new vote');
  assert.deepEqual(await webrings.ringVoteCounts(db, 'r1'), { alpha: 3, beta: 1 });
});

test('a voter is capped per hour across every site', async () => {
  for (let i = 0; i < webrings.RING_VOTE_HOURLY_CAP; i += 1) {
    assert.equal(
      await webrings.castRingVote(db, { ringSlug: 'r2', memberSlug: `m${i}`, voter: 'busy', now: at(i) }),
      'voted',
    );
  }
  const over = { ringSlug: 'r2', memberSlug: 'one-more', voter: 'busy' };
  assert.equal(await webrings.castRingVote(db, { ...over, now: at(30) }), 'throttled');
  assert.equal(await webrings.castRingVote(db, { ...over, now: at(61) }), 'voted', 'the window rolls');
  assert.equal((await webrings.ringVoteCounts(db, 'r2'))['one-more'], 1, 'a throttled vote was not counted');
});
