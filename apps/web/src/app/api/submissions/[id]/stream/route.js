import { q } from '@rssamplifier/db';

import { db } from '../../../../../lib/db.js';
import { TICK_MS, frame, stream } from '../../../../../lib/sse.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

/** Log lines sent on connect, so a page joined late is not blank. */
const BACKLOG = 60;

/**
 * Live progress for one submission's crawl queue.
 *
 * The same shape as the discovery stream on purpose — one client component
 * renders both, and the only real difference is what a log line is about.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ id: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { id } = await params;
  const client = db();

  const submission = await q.submissionById(client, id);
  if (!submission) {
    return new Response(JSON.stringify({ error: 'not-found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  // Resume from whatever the page already showed — see the discovery stream.
  let cursor = new URL(req.url).searchParams.get('since') || null;
  let last = '';

  // How often to look, decided once from how much there is to look at.
  //
  // Every poll counts every feed in the submission by status. That is nothing
  // for the few hundred a paste queues and it is a scan of six hundred thousand
  // index entries for a catalogue upload — which now happens, because the
  // uploader made a file that size importable. Such a queue also takes days to
  // drain, so polling it every second buys no visible smoothness at all: the
  // bar advances by a fraction of a percent an hour either way.
  const tick = pollInterval(Number(submission.queued_count ?? 0));

  return stream(async (first) => {
    const [progressRow, events] = await Promise.all([
      q.submissionProgress(client, id),
      q.submissionEvents(client, id, { since: cursor, limit: first ? BACKLOG : 200 }),
    ]);

    const frames = [];
    const total = progressRow.queued;
    const settled = progressRow.crawled + progressRow.failed;
    const done = progressRow.waiting === 0;

    const progress = {
      total,
      settled,
      // A submission with nothing queued finished the moment it was made, and
      // an empty bar reading 0% would be a lie about that.
      percent: total === 0 ? 100 : Math.floor((settled / total) * 100),
      crawled: progressRow.crawled,
      failed: progressRow.failed,
      waiting: progressRow.waiting,
      done,
    };

    const signature = JSON.stringify(progress);
    if (first || signature !== last) {
      frames.push(frame('progress', progress));
      last = signature;
    }

    for (const row of events) {
      frames.push(
        frame('log', {
          kind: 'feed',
          subject: String(row.title ?? row.slug ?? ''),
          status: String(row.status ?? ''),
          detail: row.last_error == null ? null : String(row.last_error),
          slug: row.slug == null ? null : String(row.slug),
          amount: row.item_count == null ? null : Number(row.item_count),
          at: String(row.at),
        }),
      );
      cursor = String(row.at);
    }

    return { frames, done };
  }, { tick });
}

/**
 * Milliseconds between polls, for a queue of this size.
 *
 * Stepped rather than continuous, because the only thing being decided is which
 * of "responsive", "steady" and "leave it alone" a queue deserves, and a formula
 * would invite reading precision into it that is not there.
 *
 * @param {number} queued
 * @returns {number}
 */
function pollInterval(queued) {
  if (queued > 100_000) return 15_000;
  if (queued > 10_000) return 5_000;
  return TICK_MS;
}
