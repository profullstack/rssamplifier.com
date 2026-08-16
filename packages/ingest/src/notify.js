import { q } from '@rssamplifier/db';
import { sendEmail, emailEnabled } from '@rssamplifier/mail';

/**
 * Telling submitters their import finished.
 *
 * A queued catalogue can take hours to crawl, which is far longer than anyone
 * will keep a tab open. The status page covers people who bookmark it; this
 * covers the rest.
 *
 * Email is optional infrastructure: with no RESEND_API_KEY configured the
 * whole path turns into a no-op rather than an error, because a directory that
 * cannot send mail should still accept submissions.
 */

export { emailEnabled };

/**
 * Send one "your import finished" note.
 *
 * @param {{ to: string, submissionId: string, crawled: number, failed: number, queued: number }} params
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendSubmissionEmail(params) {
  const site = process.env['SITE_URL'] || 'https://rssamplifier.com';
  const statusUrl = `${site}/submissions/${params.submissionId}`;

  const lines = [
    `Your submission to RSS Amplifier has finished crawling.`,
    ``,
    `  Blogs added:   ${params.crawled}`,
    `  Not reachable: ${params.failed}`,
    `  Total queued:  ${params.queued}`,
    ``,
    `Full status: ${statusUrl}`,
  ];

  return sendEmail({
    to: params.to,
    subject: `Your ${params.queued} feeds are indexed`,
    text: lines.join('\n'),
  });
}

/**
 * Notify every submission whose queue has drained, once each.
 *
 * The row is marked notified whether or not the send succeeded. A transient
 * provider failure retried on every poller tick would mean a submitter whose
 * address bounces gets the same message every minute forever; one attempt and a
 * logged failure is the friendlier trade.
 *
 * @param {import('@libsql/client').Client} db
 * @param {number} [limit]
 * @returns {Promise<{ sent: number, failed: number }>}
 */
export async function notifyFinishedSubmissions(db, limit = 5) {
  if (!emailEnabled()) return { sent: 0, failed: 0 };

  const due = await q.submissionsAwaitingNotice(db, limit);
  let sent = 0;
  let failed = 0;

  for (const row of due) {
    const id = String(row.id);
    const progress = await q.submissionProgress(db, id);

    const res = await sendSubmissionEmail({
      to: String(row.notify_email),
      submissionId: id,
      crawled: progress.crawled,
      failed: progress.failed,
      queued: progress.queued,
    });

    await q.markSubmissionNotified(db, id);
    if (res.ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed };
}
