import { ringLeaderboard } from '../../../lib/ringLeaderboard.js';

/**
 * /ring/leaders.json: the boards, periods and badges of the ring
 * leaderboard as data. A sibling of /ring/leaders rather than under it, which
 * the catch-all there cannot answer, so it has a route of its own.
 */
export const dynamic = 'force-dynamic';

/** @param {Request} request */
export async function GET(request) {
  return (await ringLeaderboard().handle(request)) ?? new Response('Not found', { status: 404 });
}

export const HEAD = GET;
