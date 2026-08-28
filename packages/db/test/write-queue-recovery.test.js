import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isWaitTimeout, recoverFinished } from '../src/writeQueue.js';

/**
 * The outage these tests are written from, 2026-08-27 20:48 to 2026-08-28 14:11.
 *
 * Every write wait expired while nothing at all was acting on the completion
 * events. The precise mechanism inside BullMQ was never pinned down and these
 * tests do not depend on it; what was measured is below.
 *
 * Nothing else was wrong. The worker was healthy, the database answered an
 * empty write transaction in 0.34s, and the jobs ran and committed — the
 * completion events were written to the stream with their full return values.
 * Nobody was reading them. So every caller waited out `WAIT_MS` and was told
 * its write had failed, when the write had in fact landed.
 *
 * Two consequences, and the tests below cover the second:
 *
 * - Throughput. `createWriteFolder` keeps one job in flight per process, so the
 *   whole cluster fell to one write attempt per two minutes for seventeen
 *   hours.
 * - Correctness. A committed write reported as a failure makes the crawler
 *   record an error against a healthy feed and re-crawl a row it already
 *   stored.
 *
 * Tested against stubs rather than a broker, for the reason `runWriteJob` is:
 * the judgement is in "what do we believe when the notification never came",
 * and the BullMQ plumbing is not the part that was wrong.
 */

/**
 * A stand-in for the job's script backend.
 *
 * `isFinished` is the primitive `waitUntilFinished` itself polls with, and its
 * contract is the one being relied on: `[status, result]`, where a zero status
 * means unfinished, -1 and 2 mean failed, and anything else means completed
 * with `result` holding the JSON return value.
 *
 * @param {[number, string]|Error} answer
 */
function stubJob(answer) {
  return {
    id: 57228,
    backend: {
      isFinished: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

test('a completed job whose notification was lost gives back its results', async () => {
  // The exact shape production was throwing away: two statements, the second
  // carrying the RETURNING row that `storeCrawl` reads to decide how many posts
  // it stored.
  const returned = [
    { rowsAffected: 0, columns: [], rows: [] },
    { rowsAffected: 1, columns: ['item_count'], rows: [{ item_count: 11 }] },
  ];

  const recovered = await recoverFinished(stubJob([1, JSON.stringify(returned)]));

  assert.deepEqual(recovered, returned, 'the write landed, so its results are still owed to the caller');
});

test('a job that is genuinely still running is not mistaken for a finished one', async () => {
  // Status 0 is the honest "not finished". Answering anything but null here
  // would hand a caller results for a transaction that has not committed.
  assert.equal(await recoverFinished(stubJob([0, ''])), null);
});

test('a job that failed every attempt reports its own reason, not the wait', async () => {
  // -1 and 2 are the two codes BullMQ treats as failure. The caller learns what
  // the database said instead of learning how long we waited.
  for (const status of [-1, 2]) {
    await assert.rejects(
      () => recoverFinished(stubJob([status, 'UNIQUE constraint failed: authors.slug'])),
      /UNIQUE constraint failed: authors\.slug/,
      `status ${status} is a failure`,
    );
  }
});

test('an unreadable job state is not treated as success', async () => {
  // Redis unreachable while we were asking. Null, so the caller still fails --
  // the one thing that must never happen is inventing a result.
  assert.equal(await recoverFinished(stubJob(new Error('connection lost'))), null);

  // Completed, but the return value is not the array of result sets the caller
  // is owed. Better to fail than to hand back something of the wrong shape.
  assert.equal(await recoverFinished(stubJob([1, 'not json'])), null);
  assert.equal(await recoverFinished(stubJob([1, '{"not":"an array"}'])), null);
});

test('only the wait timeout opens the recovery path', async () => {
  // Matched on the message because BullMQ throws a plain Error for it. If this
  // ever stops matching, every timed-out write goes back to being reported as a
  // failure -- silently, which is why it is pinned here against the real text.
  const real = new Error(
    'Job wait batch timed out before finishing, no finish notification arrived after 120000ms (id=57228)',
  );

  assert.equal(isWaitTimeout(real), true);
  assert.equal(isWaitTimeout(new Error('The operation was aborted due to timeout')), false);
  assert.equal(isWaitTimeout(new Error('UNIQUE constraint failed: authors.slug')), false);
  assert.equal(isWaitTimeout('some string'), false);
});
