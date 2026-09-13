import { createLeaderboard, projectionStore } from '@profullstack/leaderboard';
import { profiles, webrings } from '@rssamplifier/db';

import { db, siteUrl } from './db.js';

/**
 * What each action with a ring is worth. A reading of the event log, not a
 * column: change a number here and every board re-weights on the next read.
 * Sharing pays best because a share is what brings the next reader.
 */
export const POINTS = { view: 1, like: 2, follow: 3, share: 5, add: 5, make: 20 };

/**
 * A name for a reader that is not their address: the handle of an author
 * profile they claimed, if any, else a reader number from their id.
 *
 * @param {import('@rssamplifier/db').Client} client
 * @param {string[]} ids
 * @returns {Promise<Record<string, string>>}
 */
async function readerNames(client, ids) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const id of ids) {
    let name = '';
    try {
      const mine = await profiles.profilesForUser(client, id);
      const first = Array.isArray(mine) ? mine[0] : null;
      name = first ? String(first.display_name ?? first.name ?? first.handle ?? '') : '';
    } catch {
      name = '';
    }
    out[id] = name || `Reader ${id.slice(-4)}`;
  }
  return out;
}

/**
 * Every ring event since a moment, as two players' worth of score: the
 * reader who did it (points and one per kind) and the ring it was done to
 * (ring_points and ring_<kind>). An event nobody was signed in for scores
 * the ring only.
 *
 * @param {{ since: number }} args
 */
async function events({ since }) {
  const sinceIso = new Date(since || 0).toISOString();
  const client = db();
  const rows = await webrings.ringEventsSince(client, sinceIso);
  const slugs = [...new Set(rows.map((r) => r.ring_slug))];
  const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const [names, readers] = await Promise.all([webrings.ringNames(client, slugs), readerNames(client, ids)]);

  const out = [];
  for (const r of rows) {
    const at = Date.parse(r.created_at);
    const worth = POINTS[r.kind] ?? 1;
    if (r.user_id) {
      const player = `u:${r.user_id}`;
      const name = readers[r.user_id];
      out.push({ player, name, metric: 'points', delta: worth, at });
      out.push({ player, name, metric: r.kind, delta: 1, at });
    }
    const ring = `ring:${r.ring_slug}`;
    const title = names[r.ring_slug] ?? r.ring_slug;
    out.push({ player: ring, name: title, metric: 'ring_points', delta: worth, at });
    out.push({ player: ring, name: title, metric: `ring_${r.kind}`, delta: 1, at });
  }
  return out;
}

/** @type {ReturnType<typeof createLeaderboard> | null} */
let board = null;

/**
 * The ring leaderboard, at /ring/leaders: the people who do the most with
 * rings on one side, the rings people do the most with on the other.
 */
export function ringLeaderboard() {
  board ??= createLeaderboard({
    siteName: 'RSS Amplifier webrings',
    siteUrl: siteUrl(),
    basePath: '/ring/leaders',
    store: projectionStore({ events }),
    sides: { use: 'People', sell: 'Rings' },
    boards: {
      points: { label: 'Most active', metric: 'points', format: 'integer', unit: 'Points', side: 'use', actor: 'Reader' },
      sharers: { label: 'Top sharers', metric: 'share', format: 'integer', unit: 'Shares', side: 'use', actor: 'Reader' },
      makers: { label: 'Ring makers', metric: 'make', format: 'integer', unit: 'Rings made', side: 'use', actor: 'Reader' },
      curators: { label: 'Sites added', metric: 'add', format: 'integer', unit: 'Sites', side: 'use', actor: 'Reader' },
      watchers: { label: 'Most sites viewed', metric: 'view', format: 'integer', unit: 'Views', side: 'use', actor: 'Reader' },
      hot: { label: 'Hottest rings', metric: 'ring_points', format: 'integer', unit: 'Points', side: 'sell', actor: 'Ring' },
      liked: { label: 'Most liked', metric: 'ring_like', format: 'integer', unit: 'Likes', side: 'sell', actor: 'Ring' },
      shared: { label: 'Most shared', metric: 'ring_share', format: 'integer', unit: 'Shares', side: 'sell', actor: 'Ring' },
      viewed: { label: 'Most viewed', metric: 'ring_view', format: 'integer', unit: 'Views', side: 'sell', actor: 'Ring' },
    },
    ladder: null,
    cacheMs: 60_000,
  });
  return board;
}
