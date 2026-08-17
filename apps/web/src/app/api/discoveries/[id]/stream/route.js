import { discovery } from '@rssamplifier/db';

import { db } from '../../../../../lib/db.js';
import { frame, stream } from '../../../../../lib/sse.js';

export const dynamic = 'force-dynamic';
// The stream is the request. It must be allowed to outlive a normal handler.
export const maxDuration = 800;

/** Log lines sent on connect, so a page joined late is not blank. */
const BACKLOG = 60;

/**
 * Live progress for one keyword run.
 *
 * Emits `progress` whenever the counts move and `log` for each keyword searched
 * or site checked. Both are driven off the run's own rows, so a reconnecting
 * client resumes exactly where it left off and a run finished while nobody was
 * watching still replays its tail.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ id: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { id } = await params;
  const client = db();

  const run = await discovery.runById(client, id);
  if (!run) {
    return new Response(JSON.stringify({ error: 'not-found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  // The page has usually rendered the log's recent history already. Starting
  // from what it last showed is what stops the first tick repeating all of it
  // back underneath itself.
  let cursor = new URL(req.url).searchParams.get('since') || null;
  let last = '';

  return stream(async (first) => {
    const [keywords, candidates, events] = await Promise.all([
      discovery.keywordProgress(client, id),
      discovery.runProgress(client, id),
      discovery.eventsForRun(client, id, {
        since: cursor,
        // The first read is the catch-up; after that only new lines exist.
        limit: first ? BACKLOG : 200,
      }),
    ]);

    const frames = [];

    // Counted, not summed: a keyword still to search is as much outstanding
    // work as a site still to check, and a bar that ignored either would sit
    // at 100% while the run was visibly still going.
    const total = keywords.total + candidates.total;
    const settled = total - keywords.waiting - candidates.waiting;
    const done = keywords.waiting === 0 && candidates.waiting === 0;

    const progress = {
      total,
      settled,
      percent: total === 0 ? 0 : Math.floor((settled / total) * 100),
      keywords: {
        total: keywords.total,
        searched: keywords.searched,
        failed: keywords.failed,
        waiting: keywords.waiting,
      },
      sites: {
        total: candidates.total,
        accepted: candidates.accepted,
        rejected: candidates.rejected,
        errored: candidates.errored,
        waiting: candidates.waiting,
      },
      done,
    };

    // Only when something moved: an idle run should cost the client nothing to
    // watch, and a re-render per second of identical numbers is not free.
    const signature = JSON.stringify(progress);
    if (first || signature !== last) {
      frames.push(frame('progress', progress));
      last = signature;
    }

    for (const row of events) {
      frames.push(
        frame('log', {
          kind: String(row.kind),
          subject: String(row.subject ?? ''),
          status: String(row.status ?? ''),
          detail: row.detail == null ? null : String(row.detail),
          slug: row.slug == null ? null : String(row.slug),
          amount: row.amount == null ? null : Number(row.amount),
          at: String(row.at),
        }),
      );
      cursor = String(row.at);
    }

    return { frames, done };
  });
}
