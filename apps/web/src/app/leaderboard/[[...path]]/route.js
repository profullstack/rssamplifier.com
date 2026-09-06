import { leaderboard } from '../../../lib/leaderboard.js';

/**
 * The public board: who pays for the directory, and who just asks.
 *
 * One catch-all route rather than a page plus a pile of API endpoints, because
 * the board serves its own HTML, JSON, RSS, per-agent share cards and the
 * embed widget, all under this path.
 */
export const dynamic = 'force-dynamic';

export async function GET(request) {
  return (await leaderboard().handle(request)) ?? new Response('Not found', { status: 404 });
}

export const HEAD = GET;
