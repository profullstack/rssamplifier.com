import { discovery } from '@rssamplifier/db';

import { db, siteUrl } from '../../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Progress of one keyword discovery run, as JSON.
 *
 * Two queues drain here, not one — keywords still to search and sites still to
 * check — and `done` means both are empty. An agent that posted keywords polls
 * this to find out what it got.
 *
 * @param {Request} _req
 * @param {{ params: Promise<{ id: string }> }} ctx
 */
export async function GET(_req, { params }) {
  const { id } = await params;
  const client = db();

  const run = await discovery.runById(client, id);
  if (!run) return json({ error: 'not-found' }, 404);

  const [keywords, candidates, accepted] = await Promise.all([
    discovery.keywordProgress(client, id),
    discovery.runProgress(client, id),
    discovery.acceptedForRun(client, id, 500),
  ]);

  let terms = [];
  try {
    terms = JSON.parse(String(run.keywords ?? '[]'));
  } catch {
    terms = [];
  }

  return json({
    id: run.id,
    status: run.status,
    createdAt: run.created_at,
    completedAt: run.completed_at,
    // Set when the search provider, not the run, is the problem.
    error: run.error ?? null,
    keywords: {
      all: terms,
      searched: keywords.searched,
      failed: keywords.failed,
      waiting: keywords.waiting,
    },
    sites: {
      found: candidates.total,
      accepted: candidates.accepted,
      rejected: candidates.rejected,
      errored: candidates.errored,
      waiting: candidates.waiting,
    },
    done: keywords.waiting === 0 && candidates.waiting === 0,
    added: accepted.map((row) => ({
      slug: String(row.slug),
      title: row.title ? String(row.title) : null,
      host: String(row.host),
      keyword: row.keyword ? String(row.keyword) : null,
      score: row.score == null ? null : Number(row.score),
      url: `${siteUrl()}/${row.slug}`,
    })),
    notify: run.notify_email ? 'requested' : 'none',
    notifiedAt: run.notified_at,
    page: `${siteUrl()}/discoveries/${run.id}`,
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
      'cache-control': 'no-store',
    },
  });
}
