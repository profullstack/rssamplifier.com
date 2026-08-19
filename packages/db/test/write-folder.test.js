import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWriteFolder, isStatementError, settleGroup } from '../src/writeFolder.js';

/**
 * The folding that both write paths depend on.
 *
 * Written when the Redis queue turned out not to have it. `queueWrites` posted
 * one job per caller and the worker -- correctly at concurrency 1, because
 * SQLite permits one writer -- retired them at one remote transaction each,
 * about 370ms. That is a cluster-wide ceiling of roughly 2.7 writes a second,
 * and in production on 2026-08-19 it stalled an import of 65,474 entries
 * completely for over an hour while item ingestion halved.
 */

/**
 * A `run` that records what it was asked to do, one transaction per call.
 *
 * @param {{ ms?: number, fail?: (sql: string[]) => boolean }} [opts]
 */
function recorder({ ms = 2, fail = () => false } = {}) {
  const state = { runs: [], depth: 0, peak: 0 };

  return {
    state,
    run: async (statements) => {
      state.depth += 1;
      state.peak = Math.max(state.peak, state.depth);
      try {
        await new Promise((r) => setTimeout(r, ms));
        const sql = statements.map((s) => String(s.sql));
        state.runs.push(sql);
        if (fail(sql)) throw new Error('SQLITE_CONSTRAINT: unique failed');
        return sql.map((text) => ({ sql: text }));
      } finally {
        state.depth -= 1;
      }
    },
  };
}

const stmt = (sql) => [{ sql }];

test('callers waiting together are folded into one transaction', async () => {
  const { run, state } = recorder();
  const fold = createWriteFolder({ run, maxStatements: 1000 });

  await Promise.all(Array.from({ length: 12 }, (_, i) => fold(stmt(`write ${i}`))));

  assert.equal(state.peak, 1, 'never more than one transaction open');
  assert.ok(state.runs.length < 12, `folded, saw ${state.runs.length} transactions for 12 callers`);
  assert.equal(state.runs.flat().length, 12, 'and every statement still ran');
});

test('without folding every caller is its own transaction', async () => {
  // The shipped queue behaviour, and the ceiling it creates: twelve callers,
  // twelve round trips, however fast the queue in front of them is.
  const { run, state } = recorder();
  const fold = createWriteFolder({ run, maxStatements: 1 });

  await Promise.all(Array.from({ length: 12 }, (_, i) => fold(stmt(`write ${i}`))));

  assert.equal(state.runs.length, 12);
});

test('each caller gets back only its own results, in order', async () => {
  const { run } = recorder();
  const fold = createWriteFolder({ run, maxStatements: 1000 });

  const [a, b] = await Promise.all([
    fold([{ sql: 'a1' }, { sql: 'a2' }]),
    fold([{ sql: 'b1' }]),
  ]);

  assert.deepEqual(a, [{ sql: 'a1' }, { sql: 'a2' }]);
  assert.deepEqual(b, [{ sql: 'b1' }]);
});

test('the ceiling bounds a group without stranding an oversized caller', async () => {
  const { run, state } = recorder();
  const fold = createWriteFolder({ run, maxStatements: 3 });

  await Promise.all([
    fold([{ sql: 'x1' }, { sql: 'x2' }, { sql: 'x3' }, { sql: 'x4' }, { sql: 'x5' }]),
    fold(stmt('y1')),
    fold(stmt('y2')),
  ]);

  // The five-statement caller exceeds the ceiling on its own and must still
  // run rather than wait for a group it can never fit into.
  assert.ok(state.runs.some((r) => r.length === 5), 'the oversized caller ran');
  assert.equal(state.runs.flat().length, 7);
});

test('one bad statement fails only its own caller', async () => {
  // Folding must not make a neighbouring feed collateral damage: a constraint
  // error is local to its SQL, so the group is retried one caller at a time.
  const { run, state } = recorder({ fail: (sql) => sql.includes('BOOM') });
  const fold = createWriteFolder({ run, maxStatements: 1000 });

  const results = await Promise.allSettled([
    fold(stmt('ok-1')),
    fold(stmt('BOOM')),
    fold(stmt('ok-2')),
  ]);

  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'fulfilled');
  assert.ok(state.runs.length > 1, 'the group was split to isolate the failure');
});

test('a transport failure is not multiplied into one retry per caller', async () => {
  // The opposite case: a deadline or a dropped connection is about the database
  // as a whole, and re-running each caller separately would amplify an outage.
  const { state, run } = recorder();
  const failing = {
    state,
    run: async (statements) => {
      await run(statements).catch(() => {});
      throw new Error('The operation was aborted due to timeout');
    },
  };
  const fold = createWriteFolder({ run: failing.run, maxStatements: 1000 });

  const results = await Promise.allSettled([fold(stmt('a')), fold(stmt('b')), fold(stmt('c'))]);

  assert.ok(results.every((r) => r.status === 'rejected'));
  // The invariant is per-statement, not per-group: the first caller always
  // starts on its own (nobody else has arrived yet), so two groups here is
  // correct folding. What must not happen is the failed group being re-run one
  // caller at a time, which would show up as statements attempted twice.
  assert.equal(state.runs.flat().length, 3, 'each statement attempted exactly once');
});

test('the error classifier tells a bad statement from a bad connection', () => {
  assert.equal(isStatementError(new Error('SQLITE_CONSTRAINT: UNIQUE failed')), true);
  assert.equal(isStatementError(new Error('no such column: wat')), true);
  assert.equal(isStatementError(new Error('The operation was aborted due to timeout')), false);
  assert.equal(isStatementError(new Error('fetch failed')), false);
});

test('results are sliced by statement count, not by caller count', () => {
  const group = [
    { statements: [1, 2], resolve: (v) => (group[0].got = v) },
    { statements: [3], resolve: (v) => (group[1].got = v) },
  ];
  settleGroup(group, ['r1', 'r2', 'r3']);

  assert.deepEqual(group[0].got, ['r1', 'r2']);
  assert.deepEqual(group[1].got, ['r3']);
});
