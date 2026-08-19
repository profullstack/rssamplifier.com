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
  const state = { peak: 0, depth: 0, calls: [], batches: [], modes: [] };

  return {
    state,
    batch: async (statements, mode) => {
      state.depth += 1;
      state.peak = Math.max(state.peak, state.depth);
      state.modes.push(mode);
      try {
        await new Promise((r) => setTimeout(r, ms));
        const sql = statements.map((statement) => String(statement?.sql ?? statement));
        state.batches.push(sql);
        state.calls.push(...sql);
        if (sql.some((text) => text.includes('BOOM'))) {
          throw new Error('SQLITE_CONSTRAINT: write failed');
        }
        return sql.map((text) => ({ sql: text }));
      } finally {
        state.depth -= 1;
      }
    },
  };
}

const stmt = (sql) => [{ sql, args: [] }];

test('queued writes share transactions and never overlap', async () => {
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
  assert.ok(
    client.state.batches.length < 12,
    `queued callers should be folded together, saw ${client.state.batches.length} transactions`,
  );
});

test('writes run in the order they were asked for', async () => {
  const client = stubClient(1);
  const db = serializeWrites(client);

  await Promise.all(Array.from({ length: 6 }, (_, i) => db.batch(stmt(`n${i}`), 'write')));

  assert.deepEqual(client.state.calls, ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
});

test('each caller receives only the results for its own statements', async () => {
  const client = stubClient(5);
  const db = serializeWrites(client);

  const first = db.batch(stmt('first'), 'write');
  const second = db.batch(
    [
      { sql: 'second-a', args: [] },
      { sql: 'second-b', args: [] },
    ],
    'write',
  );
  const third = db.batch(stmt('third'), 'write');

  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results.map((sets) => sets.map((set) => set.sql)), [
    ['first'],
    ['second-a', 'second-b'],
    ['third'],
  ]);
  assert.deepEqual(client.state.batches, [['first'], ['second-a', 'second-b', 'third']]);
});

test('the statement ceiling bounds a combined transaction without changing order', async () => {
  const client = stubClient(5);
  const db = serializeWrites(client, { maxStatements: 2 });

  await Promise.all([
    db.batch(stmt('a'), 'write'),
    db.batch(stmt('b'), 'write'),
    db.batch(stmt('c'), 'write'),
    db.batch(stmt('d'), 'write'),
    db.batch(stmt('e'), 'write'),
  ]);

  assert.deepEqual(client.state.batches, [['a'], ['b', 'c'], ['d', 'e']]);
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
  assert.deepEqual(
    client.state.calls,
    ['before', 'BOOM', 'after', 'BOOM', 'after'],
    'the failed combined attempt is retried one caller at a time',
  );
});

test('a transport failure rejects the group without multiplying retries', async () => {
  const client = stubClient(5);
  const original = client.batch;
  client.batch = async (statements, mode) => {
    if (statements.some((statement) => String(statement.sql).includes('TIMEOUT'))) {
      client.state.batches.push(statements.map((statement) => String(statement.sql)));
      throw new Error('The operation was aborted due to timeout');
    }
    return original(statements, mode);
  };
  const db = serializeWrites(client);

  const results = await Promise.allSettled([
    db.batch(stmt('before'), 'write'),
    db.batch(stmt('TIMEOUT'), 'write'),
    db.batch(stmt('alongside'), 'write'),
  ]);

  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'rejected', 'the atomic combined transaction failed for both callers');
  assert.deepEqual(client.state.batches, [['before'], ['TIMEOUT', 'alongside']]);
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
