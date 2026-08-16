import { q, discovery } from '@rssamplifier/db';
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
 * Send one "your keyword search finished" note.
 *
 * @param {{ to: string, runId: string, keywords: string[], accepted: number, checked: number }} params
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendDiscoveryEmail(params) {
  const site = process.env['SITE_URL'] || 'https://rssamplifier.com';
  const statusUrl = `${site}/discoveries/${params.runId}`;
  const shown = params.keywords.slice(0, 5).join(', ');
  const more = params.keywords.length > 5 ? ` and ${params.keywords.length - 5} more` : '';

  const lines = [
    `Your keyword search on RSS Amplifier has finished.`,
    ``,
    `  Keywords:     ${shown}${more}`,
    `  Sites checked: ${params.checked}`,
    `  Blogs added:   ${params.accepted}`,
    ``,
    `Full status: ${statusUrl}`,
  ];

  return sendEmail({
    to: params.to,
    subject: `${params.accepted} new blogs from your keyword search`,
    text: lines.join('\n'),
  });
}

/**
 * Notify every discovery run whose candidate queue has drained, once each.
 *
 * Same one-attempt rule as submissions: marked notified whether or not the
 * send worked, so a bouncing address is not retried every tick forever.
 *
 * @param {import('@libsql/client').Client} db
 * @param {number} [limit]
 * @returns {Promise<{ sent: number, failed: number }>}
 */
export async function notifyFinishedDiscoveries(db, limit = 5) {
  if (!emailEnabled()) return { sent: 0, failed: 0 };

  const due = await discovery.runsAwaitingNotice(db, limit);
  let sent = 0;
  let failed = 0;

  for (const row of due) {
    const id = String(row.id);
    const progress = await discovery.runProgress(db, id);

    let keywords = [];
    try {
      keywords = JSON.parse(String(row.keywords ?? '[]'));
    } catch {
      keywords = [];
    }

    const res = await sendDiscoveryEmail({
      to: String(row.notify_email),
      runId: id,
      keywords,
      accepted: progress.accepted,
      checked: progress.total - progress.waiting,
    });

    await discovery.markRunNotified(db, id);
    if (res.ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed };
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
