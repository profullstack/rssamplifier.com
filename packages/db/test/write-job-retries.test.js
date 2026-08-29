import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UnrecoverableError } from 'bullmq';

import { runWriteJob } from '../src/writeQueue.js';

/**
 * Which write failures are worth another attempt.
 *
 * At worker concurrency 1 — which is not tunable, because SQLite has one writer
 * — a retry does not merely waste effort. The failing job holds the cluster's
 * only writer for every attempt while every other write queues behind it.
 *
 * Both failure modes below were seen in production within an hour of the queue
 * being switched on: a constraint violation retried three times to no possible
 * effect, and a timing-out job that held the writer for over a minute.
 */

/** @param {(statements: unknown[]) => Promise<unknown>} batch */
const clientWith = (batch) => ({ batch: (statements) => batch(statements) });

test('a constraint violation is not retried', async () => {
  // Deterministic: the same statements against the same data fail the same way
  // for ever. This is the exact error that retried three times in production.
  const client = clientWith(async () => {
    throw new Error('SQLITE_CONSTRAINT: SQLite error: UNIQUE constraint failed: authors.slug');
  });

  await assert.rejects(
    () => runWriteJob(client, [{ sql: 'insert into authors values (1)' }]),
    (err) => {
      assert.ok(err instanceof UnrecoverableError, 'must tell BullMQ to stop retrying');
      assert.match(err.message, /authors\.slug/, 'the reason must survive');
      return true;
    },
  );
});

test('a syntax error is not retried either', async () => {
  const client = clientWith(async () => {
    throw new Error('SQLITE_ERROR: no such column: nope');
  });

  await assert.rejects(
    () => runWriteJob(client, [{ sql: 'select nope' }]),
    (err) => err instanceof UnrecoverableError,
  );
});

test('a timeout IS retried, because the next attempt can differ', async () => {
  // The distinction that matters. Refusing to retry these would throw away the
  // main thing the queue was wanted for.
  const client = clientWith(async () => {
    throw new Error('The operation was aborted due to timeout');
  });

  await assert.rejects(
    () => runWriteJob(client, [{ sql: 'update feeds set x = 1' }]),
    (err) => {
      assert.ok(!(err instanceof UnrecoverableError), 'a timeout must stay retryable');
      assert.match(err.message, /timeout/);
      return true;
    },
  );
});

test('a transport failure is retried', async () => {
  const client = clientWith(async () => {
    throw new Error('fetch failed');
  });

  await assert.rejects(
    () => runWriteJob(client, [{ sql: 'update feeds set x = 1' }]),
    (err) => !(err instanceof UnrecoverableError),
  );
});

test('an empty job does no work and touches no client', async () => {
  let called = false;
  const client = clientWith(async () => {
    called = true;
    return [];
  });

  assert.deepEqual(await runWriteJob(client, []), []);
  assert.equal(called, false, 'an empty job must not take the writer at all');
});

test('a successful job returns one encoded result per statement', async () => {
  const client = clientWith(async (statements) =>
    statements.map(() => ({ rows: [], rowsAffected: 1, columns: [], columnTypes: [] })),
  );

  const results = await runWriteJob(client, [{ sql: 'a' }, { sql: 'b' }]);
  assert.equal(results.length, 2);
});
