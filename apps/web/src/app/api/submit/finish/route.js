import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../../lib/db.js';
import { checkUploadAccess, ipHashOf, json, normalizeEmail } from '../../../../lib/upload.js';

export const dynamic = 'force-dynamic';

/**
 * Close an upload: record what it came to, and who to tell when it finishes.
 *
 * The counts are read back off the feeds rather than taken from the client.
 * They are the same numbers `/submissions/<id>` will show, and it counts them
 * the same way — a submission whose stored total disagreed with its own status
 * page would be worse than one with no total at all.
 *
 * `notify_email` is written here and nowhere earlier, for the reason
 * `completeSubmission` documents: the poller reads "has an address and has no
 * pending feeds" as "owes an email", so an address stored while the queue was
 * still being written would be read as a finished import and mailed about
 * immediately.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const client = db();

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const id = String(body?.submissionId ?? '');
  const access = await checkUploadAccess(client, id, ipHashOf(req));
  if (!access.ok) return json({ ok: false, error: access.error }, access.status);

  const email = normalizeEmail(body?.email);
  const staged = await q.countImportEntries(client, id);

  // A staged upload is not finished, it is handed over. Marking it ready is
  // what releases it to the poller, and it is the last thing the tab has to do
  // — everything after this happens whether anyone is watching or not.
  if (staged > 0) {
    await q.markImportReady(client, id, {
      entries_total: Math.max(0, Math.floor(Number(body?.total ?? staged)) || staged),
      rejected_count: Math.max(0, Math.floor(Number(body?.invalid ?? 0)) || 0),
      notify_email: email,
    });

    return json({
      ok: true,
      submissionId: id,
      staged,
      queued: 0,
      pending: staged,
      statusUrl: `${siteUrl()}/submissions/${id}`,
      statusPath: `/submissions/${id}`,
    });
  }

  // Nothing staged means this went through the older path that queued as it
  // went, or the file held no feeds at all. Both are settled by counting what
  // actually landed.
  const progress = await q.submissionProgress(client, id);

  await q.completeSubmission(client, id, {
    accepted_count: 0,
    rejected_count: Math.max(0, Math.floor(Number(body?.invalid ?? 0)) || 0),
    queued_count: progress.queued,
    // Nobody is owed a notification about an upload that queued nothing —
    // every feed in it was already in the directory, and there is no later
    // moment at which anything will have changed.
    notify_email: progress.queued > 0 ? email : null,
    errors: [],
  });

  return json({
    ok: true,
    submissionId: id,
    queued: progress.queued,
    statusUrl: `${siteUrl()}/submissions/${id}`,
    statusPath: `/submissions/${id}`,
  });
}
