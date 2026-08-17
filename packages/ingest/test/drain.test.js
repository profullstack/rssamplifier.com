import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q } from '@rssamplifier/db';

import { drainImport } from '../src/drain.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-drain-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Stage `n` entries against a fresh submission, as the uploader would. */
async function stage(id, n, prefix) {
  await q.insertSubmission(db, { id, kind: 'opml', raw_input: '' });
  const entries = Array.from({ length: n }, (_, i) => ({
    url: `https://${prefix}${i}.example/rss`,
    title: `${prefix} ${i}`,
  }));
  await q.stageImportEntries(db, id, entries);
  return entries;
}

test('nothing to drain is not an error', async () => {
  assert.deepEqual(await drainImport(db), { ran: false });
});

test('a list that has not been handed over yet is left alone', async () => {
  await stage('drain-open', 10, 'open');

  // No markImportReady: the uploader is still sending. Draining now would
  // schedule the first part of the catalogue behind the part still arriving.
  assert.deepEqual(await drainImport(db), { ran: false });
  assert.equal(await q.countImportEntries(db, 'drain-open'), 10);
});

test('a handed-over list becomes feeds, a slice at a time', async () => {
  await stage('drain-ready', 25, 'ready');
  await q.markImportReady(db, 'drain-ready', { entries_total: 25 });

  const first = await drainImport(db, { slice: 10 });
  assert.equal(first.ran, true);
  assert.equal(first.queued, 10);
  assert.equal(first.remaining, 15);
  assert.equal(first.finished, false);

  await drainImport(db, { slice: 10 });
  const last = await drainImport(db, { slice: 10 });

  assert.equal(last.remaining, 0);
  assert.equal(last.finished, true);
  assert.equal(await q.countImportEntries(db, 'drain-ready'), 0);

  const progress = await q.submissionProgress(db, 'drain-ready');
  assert.equal(progress.queued, 25);
  assert.equal(progress.pending, 0, 'nothing left staged');
});

test('an interrupted drain resumes rather than repeating', async () => {
  await stage('drain-resume', 20, 'resume');
  await q.markImportReady(db, 'drain-resume', { entries_total: 20 });

  await drainImport(db, { slice: 8 });
  assert.equal(await q.countImportEntries(db, 'drain-resume'), 12);

  // Whatever happens next, the eight already queued are not queued again.
  await drainImport(db, { slice: 8 });
  await drainImport(db, { slice: 8 });

  const progress = await q.submissionProgress(db, 'drain-resume');
  assert.equal(progress.queued, 20, 'each entry became exactly one feed');
});

test('the oldest handed-over list is drained first', async () => {
  await stage('drain-older', 5, 'older');
  await q.markImportReady(db, 'drain-older', { entries_total: 5 });
  // markImportReady stamps the current time, so force the order deterministically.
  await db.execute({
    sql: `update submissions set entries_ready_at = '2020-01-01T00:00:00.000Z' where id = ?`,
    args: ['drain-older'],
  });

  await stage('drain-newer', 5, 'newer');
  await q.markImportReady(db, 'drain-newer', { entries_total: 5 });

  const first = await drainImport(db, { slice: 50 });
  assert.equal(first.submissionId, 'drain-older');
});

test('a submission still being handed over is not told it has finished', async () => {
  await stage('drain-notify', 12, 'notify');
  await q.markImportReady(db, 'drain-notify', {
    entries_total: 12,
    notify_email: 'someone@example.com',
  });

  // The window this guards: an address is on the row and no feed exists yet, so
  // "nothing pending" is true for a reason that is the opposite of finished.
  let due = await q.submissionsAwaitingNotice(db);
  assert.equal(
    due.find((r) => String(r.id) === 'drain-notify'),
    undefined,
    'mailed about an import that had not started',
  );

  // Drain it all, and only then is it something to write home about.
  for (let i = 0; i < 5; i += 1) await drainImport(db, { slice: 50 });
  await db.execute("update feeds set status = 'active' where submission_id = 'drain-notify'");

  due = await q.submissionsAwaitingNotice(db);
  assert.ok(
    due.some((r) => String(r.id) === 'drain-notify'),
    'a drained import should be notifiable',
  );
});
