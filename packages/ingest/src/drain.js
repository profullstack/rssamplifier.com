import { q } from '@rssamplifier/db';

import { queueFeeds } from './queue.js';

/** Entries taken from staging per pass. Matches the uploader's own batch size. */
const SLICE = 2000;

/**
 * Queue a slice of whatever upload is waiting, and say what is left.
 *
 * This is the half of an import that used to live in the browser. The uploader
 * now only records what it read, which is fast enough to hand over a very large
 * catalogue in a minute; the queueing — lookups, slugs, scheduling — happens
 * here, on a process that is running anyway and does not care whether anyone is
 * still watching.
 *
 * One slice per call rather than a whole submission per call, so a 620,000-entry
 * catalogue does not hold the tick for half an hour: the poller comes back to it
 * next time round, and the crawl it is also responsible for keeps running in
 * between.
 *
 * Entries are deleted only once their feeds are written, so a process killed
 * mid-drain resumes rather than repeats. Queueing is idempotent anyway — a feed
 * already in the directory is skipped — but the entries table is what makes the
 * resume cheap.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ slice?: number, offsetMinutes?: number, ratePerMinute?: number }} [opts]
 * @returns {Promise<{ ran: boolean, submissionId?: string, queued?: number, skipped?: number, invalid?: number, remaining?: number, finished?: boolean }>}
 */
export async function drainImport(db, opts = {}) {
  const next = await q.nextImportToDrain(db);
  if (!next) return { ran: false };

  const slice = opts.slice ?? SLICE;
  const staged = await q.takeImportEntries(db, next.id, slice);
  if (staged.length === 0) return { ran: false };

  // Where this slice sits in the upload as a whole, so the crawl schedule
  // continues the line rather than restarting it for every slice. Derived from
  // what is left rather than carried along: the client's count is gone by now,
  // and the remainder is the one number that is certainly true.
  const remainingBefore = await q.countImportEntries(db, next.id);
  const done = Math.max(0, next.entries_total - remainingBefore);

  const result = await queueFeeds(db, staged, {
    submissionId: next.id,
    offsetMinutes: done / (opts.ratePerMinute ?? 240),
    ratePerMinute: opts.ratePerMinute,
  });

  await q.dropImportEntries(
    db,
    staged.map((e) => e.id),
  );

  const remaining = await q.countImportEntries(db, next.id);

  // The last slice is where the submission stops being an upload in progress
  // and becomes a queue being crawled, which is what the status page and the
  // notification both key off.
  if (remaining === 0) {
    const progress = await q.submissionProgress(db, next.id);
    const submission = await q.submissionById(db, next.id);

    await q.completeSubmission(db, next.id, {
      accepted_count: Number(submission?.accepted_count ?? 0),
      rejected_count: Number(submission?.rejected_count ?? 0),
      queued_count: progress.queued,
      // Same rule as everywhere else: an upload that queued nothing has nothing
      // left to happen, so there is nothing to be told about.
      notify_email: progress.queued > 0 ? (submission?.notify_email ?? null) : null,
      errors: [],
    });
  }

  return {
    ran: true,
    submissionId: next.id,
    queued: result.queued,
    skipped: result.skipped,
    invalid: result.invalid,
    remaining,
    finished: remaining === 0,
  };
}
