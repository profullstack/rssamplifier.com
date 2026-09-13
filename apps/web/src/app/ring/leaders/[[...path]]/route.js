import { ringLeaderboard } from '../../../../lib/ringLeaderboard.js';

/**
 * /ring/leaders, and everything under it, is the house leaderboard module
 * (@profullstack/leaderboard) over the ring event log: the page, the JSON
 * and RSS of each board, a share card per player, the embeddable widget.
 */
export const dynamic = 'force-dynamic';

/** @param {Request} request */
export async function GET(request) {
  return (await ringLeaderboard().handle(request)) ?? new Response('Not found', { status: 404 });
}

export const HEAD = GET;
