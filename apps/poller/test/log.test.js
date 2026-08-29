import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRecorder, toEntry, writeFailure } from '../src/log.js';

test("a tick's fields become columns, and the rest rides along as JSON", () => {
  const entry = toEntry('crawl', { crawled: 25, failed: 1, items: 12, ms: 4200, due: 400 });

  assert.equal(entry.event, 'crawl');
  assert.equal(entry.ms, 4200);
  assert.deepEqual(JSON.parse(entry.detail), { crawled: 25, failed: 1, items: 12, due: 400 });
  assert.equal(entry.status, null, 'a routine line is neither good nor bad news');
});

test('an error event is marked as one', () => {
  assert.equal(toEntry('crawl-error', { message: 'boom' }).status, 'error');
  assert.equal(toEntry('rollup-error', { message: 'boom' }).detail, 'boom');
  // A message is what makes a line bad news, whatever the event is called.
  assert.equal(toEntry('discovery', { message: 'unreachable' }).status, 'error');
});

test('an event with nothing to add carries no payload', () => {
  const entry = toEntry('started', {});
  assert.equal(entry.detail, null);
  assert.equal(entry.amount, null);
});

test('lines are written in one batch rather than one at a time', async () => {
  const batches = [];
  const recorder = createRecorder({ append: async (rows) => batches.push(rows), flushMs: 5 });

  recorder.record({ event: 'feed', subject: 'a' });
  recorder.record({ event: 'feed', subject: 'b' });
  recorder.record({ event: 'feed', subject: 'c' });

  assert.equal(batches.length, 0, 'nothing is written while the crawl is still working');
  assert.equal(recorder.pending(), 3);

  await recorder.flush();

  assert.equal(batches.length, 1, 'twenty-five feeds must not be twenty-five round trips');
  assert.equal(batches[0].length, 3);
  assert.ok(batches[0][0].at, 'a line is stamped when it happens, not when it is written');
});

test('a line that already knows when it happened keeps its own timestamp', async () => {
  const batches = [];
  const recorder = createRecorder({ append: async (rows) => batches.push(rows) });

  recorder.record({ event: 'feed', at: '2026-08-17T12:00:00.000Z', subject: 'a' });
  await recorder.flush();

  assert.equal(batches[0][0].at, '2026-08-17T12:00:00.000Z');
});

test('the buffer is a cap, and an overflow says so instead of going quiet', async () => {
  const batches = [];
  const recorder = createRecorder({ append: async (rows) => batches.push(rows), maxBuffer: 3 });

  for (const subject of ['a', 'b', 'c', 'd', 'e']) recorder.record({ event: 'feed', subject });

  assert.equal(recorder.pending(), 3, 'memory is bounded whatever the crawler does');

  await recorder.flush();
  const written = batches[0];

  assert.equal(written[0].event, 'log-dropped');
  assert.equal(written[0].amount, 2);
  assert.deepEqual(
    written.slice(1).map((r) => r.subject),
    ['c', 'd', 'e'],
    'the tail is kept: it is the part anybody is watching',
  );
});

test('a failed write loses its lines and reports the gap once', async () => {
  const seen = [];
  const errors = [];
  let fail = true;

  const recorder = createRecorder({
    append: async (rows) => {
      if (fail) throw new Error('turso unreachable');
      seen.push(rows);
    },
    onError: (err) => errors.push(String(err.message)),
  });

  recorder.record({ event: 'feed', subject: 'lost' });
  await recorder.flush();

  assert.equal(errors.length, 1);
  assert.equal(seen.length, 0);

  // The next successful flush admits the gap rather than pretending the log is
  // continuous — and admits it exactly once.
  fail = false;
  recorder.record({ event: 'feed', subject: 'kept' });
  await recorder.flush();

  assert.equal(seen[0][0].event, 'log-dropped');
  assert.equal(seen[0][0].amount, 1);

  recorder.record({ event: 'feed', subject: 'also kept' });
  await recorder.flush();
  assert.ok(
    !seen[1].some((r) => r.event === 'log-dropped'),
    'the same gap must not be reported on every subsequent flush',
  );
});

test('shutting down writes what is left and then stops accepting lines', async () => {
  const batches = [];
  const recorder = createRecorder({ append: async (rows) => batches.push(rows) });

  recorder.record({ event: 'stopping', subject: 'SIGTERM' });
  await recorder.stop();

  assert.equal(batches[0][0].event, 'stopping');

  recorder.record({ event: 'feed', subject: 'too late' });
  assert.equal(recorder.pending(), 0);
});

test('a retry still to come is not yet a failure', () => {
  // The shape BullMQ hands the `failed` listener on the first of three attempts.
  // 81 of the 149 jobs that hit this in one production day went on to succeed,
  // so calling it a failed write is wrong twice over: it is not a failure, and
  // saying so buries the ones that are.
  const { event, fields } = writeFailure(
    { id: '57186', attemptsMade: 1, opts: { attempts: 3 } },
    new Error('The operation was aborted due to timeout'),
  );

  assert.equal(event, 'write-retried');
  assert.equal(fields.attempt, 1);
  assert.equal(fields.of, 3);
  assert.equal(fields.message, undefined, 'no message, so toEntry does not mark it an error');

  const entry = toEntry(event, fields);
  assert.equal(entry.status, null, 'and it stays out of the operational error panel');
  assert.match(JSON.parse(entry.detail).reason, /aborted due to timeout/, 'while still saying why');
});

test('the attempt that exhausts the job is the write that did not happen', () => {
  const { event, fields } = writeFailure(
    { id: '57877', attemptsMade: 3, opts: { attempts: 3 } },
    new Error('The operation was aborted due to timeout'),
  );

  assert.equal(event, 'write-failed');
  assert.equal(fields.attempts, 3);

  const entry = toEntry(event, fields);
  assert.equal(entry.status, 'error', 'this one is worth showing on the status page');
  assert.equal(entry.detail, 'The operation was aborted due to timeout');
});

test('a job with no retries left to configure fails on its first attempt', () => {
  // How an UnrecoverableError arrives — a constraint violation, which `runWriteJob`
  // refuses to retry because the same statements against the same data fail
  // identically for ever. The first attempt is also the last.
  const { event, fields } = writeFailure(
    { id: '9', attemptsMade: 1, opts: { attempts: 1 } },
    new Error('UNIQUE constraint failed: authors.slug'),
  );

  assert.equal(event, 'write-failed');
  assert.equal(fields.attempts, 1);
});

test('a missed chart sample is not an alarm', () => {
  // `toEntry` marks a row as an error two ways — an event name ending in
  // "error", or any `message` field — and the queue sample used to trip both,
  // so a burndown point that could not be taken landed on the panel that
  // answers "is anything broken" beside writes that genuinely did not happen.
  const entry = toEntry('queue-sample-missed', { reason: 'The operation was aborted due to timeout' });

  assert.equal(entry.status, null, 'a gap in a chart is not a failure');
  assert.match(JSON.parse(entry.detail).reason, /aborted due to timeout/, 'and it still says why');

  // The shape it replaced, kept here so the distinction cannot quietly rot.
  assert.equal(toEntry('queue-sample-error', { message: 'x' }).status, 'error');
});

test('a failure with no job at all is still reported', () => {
  // BullMQ can emit `failed` with no job when it could not load one. Treating
  // that as a retry would drop the only notice of it.
  const { event, fields } = writeFailure(undefined, new Error('missing job'));

  assert.equal(event, 'write-failed');
  assert.equal(fields.id, null);
  assert.equal(fields.message, 'missing job');
});
