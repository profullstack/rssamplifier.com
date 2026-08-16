import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Progress of one submission, as JSON.
 *
 * A queued catalogue is crawled over hours, so this is the endpoint a
 * submitter — or an agent that posted the catalogue — polls to find out how
 * far along it is.
 *
 * @param {Request} _req
 * @param {{ params: Promise<{ id: string }> }} ctx
 */
export async function GET(_req, { params }) {
  const { id } = await params;
  const client = db();

  const submission = await q.submissionById(client, id);

  if (!submission) {
    return json({ error: 'not-found' }, 404);
  }

  const progress = await q.submissionProgress(client, id);

  return json({
    id: submission.id,
    kind: submission.kind,
    createdAt: submission.created_at,
    // Resolved while the submitter waited.
    added: Number(submission.accepted_count ?? 0),
    rejected: Number(submission.rejected_count ?? 0),
    // Written to the crawl queue and worked through by the poller.
    queued: progress.queued,
    crawled: progress.crawled,
    failed: progress.failed,
    waiting: progress.waiting,
    done: progress.waiting === 0,
    notify: submission.notify_email ? 'requested' : 'none',
    notifiedAt: submission.notified_at,
    page: `${siteUrl()}/submissions/${submission.id}`,
  });
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      // Progress changes minute to minute; caching it would make a poller lie.
      'cache-control': 'no-store',
    },
  });
}
