import { leaderboard } from '../../lib/leaderboard.js';

/**
 * The board index, at `/leaderboard.json`.
 *
 * A route of its own because Next matches on path segments: `/leaderboard.json`
 * is a sibling of `/leaderboard`, not a child, so the catch-all under
 * `leaderboard/[[...path]]` never sees it and the request falls through to the
 * feed route, which answers "no such feed: leaderboard". The package documents
 * this path as the index, and on a framework that hands every path to one
 * handler it is the index; here it has to be spelled out.
 */
export const dynamic = 'force-dynamic';

export async function GET(request) {
  return (await leaderboard().handle(request)) ?? new Response('Not found', { status: 404 });
}

export const HEAD = GET;
