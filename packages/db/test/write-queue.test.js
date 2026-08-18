import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serializeWrites } from '../src/client.js';

/**
 * A stand-in for the libSQL client that records how many batches are inside it
 * at once.
 *
 * Tested against a stub rather than a real database on purpose: the property
 * under test is "how many transactions are open simultaneously", and once a
 * real client is wrapped there is no seam left to observe that from -- an
 * earlier version of this test wrapped the *outside* of the queue and dutifully
 * reported twelve, which is where the callers are, not where the lock is.
 *
 * @param {number} [ms] how long a batch takes
 */
function stubClient(ms = 5) {
  const state = { peak: 0, depth: 0, calls: [], modes: [] };

  return {
    state,
    batch: async (statements, mode) => {
      state.depth += 1;
      state.peak = Math.max(state.peak, state.depth);
      state.modes.push(mode);
      try {
        await new Promise((r) => setTimeout(r, ms));
        const first = statements?.[0]?.sql ?? '';
        state.calls.push(String(first));
        if (String(first).includes('BOOM')) throw new Error('write failed');
        return [];
      } finally {
        state.depth -= 1;
      }
    },
  };
}

const stmt = (sql) => [{ sql, args: [] }];

test('write transactions never overlap, however many callers there are', async () => {
  // The bug this exists to prevent, measured against production: four crawl
  // workers plus the card, cluster, author and alert passes each opened their
  // own `batch(..., 'write')` -- a dozen explicit transactions contending for a
  // lock only one could hold. They did not merely queue. They timed out at 300
  // seconds and retried, so nothing committed and crawl throughput was exactly
  // zero while single-statement writes went through in 389ms.
  const client = stubClient();
  const db = serializeWrites(client);

  await Promise.all(Array.from({ length: 12 }, (_, i) => db.batch(stmt(`write ${i}`), 'write')));

  assert.equal(client.state.peak, 1, `one write at a time, saw ${client.state.peak}`);
  assert.equal(client.state.calls.length, 12, 'and every one of them ran');
});

test('writes run in the order they were asked for', async () => {
  const client = stubClient(1);
  const db = serializeWrites(client);

  await Promise.all(Array.from({ length: 6 }, (_, i) => db.batch(stmt(`n${i}`), 'write')));

  assert.deepEqual(client.state.calls, ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
});

test('one failed write does not wedge the writes behind it', async () => {
  // The queue chains onto a settled-either-way tail deliberately. Chaining onto
  // the value would mean the first transient failure stopped every later write
  // for the life of the process, turning a blip into the outage this prevents.
  const client = stubClient(1);
  const db = serializeWrites(client);

  const results = await Promise.allSettled([
    db.batch(stmt('before'), 'write'),
    db.batch(stmt('BOOM'), 'write'),
    db.batch(stmt('after'), 'write'),
  ]);

  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected', 'the bad write still rejects its own caller');
  assert.equal(results[2].status, 'fulfilled', 'and the queue kept moving');
  assert.deepEqual(client.state.calls, ['before', 'BOOM', 'after']);
});

test('read batches are not made to wait behind writes', async () => {
  // Reads do not take the write lock, they measured fine throughout the
  // incident (80-400ms), and putting them in this queue would park a web
  // request behind a crawl.
  const client = stubClient(20);
  const db = serializeWrites(client);

  const slowWrite = db.batch(stmt('slow write'), 'write');
  const read = db.batch(stmt('select 1'), 'read');

  // The read finishes without waiting for the write, which is only observable
  // because both are in flight at once.
  await read;
  assert.ok(client.state.depth >= 1, 'the write is still running');
  assert.ok(client.state.peak >= 2, 'the read overlapped it rather than queueing');

  await slowWrite;
});

test('a batch with no mode is treated as a write', async () => {
  // libSQL's default is a deferred transaction, which can still take the write
  // lock -- so "no mode given" must not be a way around the queue.
  const client = stubClient(1);
  const db = serializeWrites(client);

  await Promise.all([db.batch(stmt('a')), db.batch(stmt('b'))]);

  assert.equal(client.state.peak, 1, 'still serialised');
});
