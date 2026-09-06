import { createLeaderboard, projectionStore } from '@profullstack/leaderboard';
import { crawlSales } from '@rssamplifier/db';

import { db, siteUrl } from './db.js';

/**
 * The public board over the crawler paywall.
 *
 * Two sides, kept apart. Agents that paid are ranked by money; agents that
 * were counted or turned away are ranked by volume. Putting them in one list
 * would say those are the same kind of fact, and the difference between them
 * is the whole argument for having a paywall at all.
 *
 * Nothing is written here. `traffic_hourly` is already the record of who asked
 * and who was refused, and `crawl_sales` is the record of who paid, so the
 * board projects both rather than keeping a third copy that could disagree
 * with either. Badges are the exception: they are awarded at a moment rather
 * than derived from a sum.
 */

/** 'YYYY-MM-DDTHH' in UTC, the shape traffic_hourly keys on. */
const hourToMs = (hour) => Date.parse(`${hour}:00:00Z`);

const badges = {
  async awardBadge(player, badge) {
    const { rowsAffected } = await db().execute({
      sql: `insert into leaderboard_badges (player, badge, awarded_at)
            values (?, ?, ?) on conflict (player, badge) do nothing`,
      args: [player, badge, new Date().toISOString()],
    });
    return Number(rowsAffected) > 0;
  },
  async badges() {
    const { rows } = await db().execute('select player, badge, awarded_at from leaderboard_badges');
    /** @type {Record<string, Record<string, number>>} */
    const out = {};
    for (const r of rows) {
      const player = String(r.player);
      out[player] ??= {};
      out[player][String(r.badge)] = Date.parse(String(r.awarded_at));
    }
    return out;
  },
};

/**
 * A wallet address is long and all of it is public, so show the ends. The
 * display name for a sale is the agent family, because "ai-openai" tells a
 * reader something that `0x46E9…6C79` does not.
 */
const shortWallet = (p) => (p.length > 14 ? `${p.slice(0, 6)}…${p.slice(-4)}` : p);

async function events({ since }) {
  const sinceIso = new Date(since || 0).toISOString();
  const client = db();
  const [sales, traffic] = await Promise.all([
    crawlSales.crawlSalesSince(client, sinceIso),
    client.execute({
      sql: `select hour, agent, sum(hits) as hits, sum(refused) as refused
            from traffic_hourly where hour >= ? group by hour, agent`,
      // traffic_hourly.hour is 'YYYY-MM-DDTHH', which compares correctly as text.
      args: [sinceIso.slice(0, 13)],
    }),
  ]);

  const out = [];
  for (const s of sales) {
    const player = s.payer ? String(s.payer) : s.agent ? `ua:${s.agent}` : null;
    if (!player) continue;
    const at = Date.parse(String(s.created_at));
    const name = s.agent ? String(s.agent) : shortWallet(String(s.payer));
    const each = (metric, delta) => out.push({ player, name, metric, delta, at });
    each('spent', Number(s.total_cents) || 0);
    each('passes', 1);
    each('days', Number(s.days) || 1);
  }
  for (const r of traffic.rows) {
    const at = hourToMs(String(r.hour));
    if (!Number.isFinite(at)) continue;
    const player = `ua:${r.agent}`;
    const name = String(r.agent);
    out.push({ player, name, metric: 'hits', delta: Number(r.hits) || 0, at });
    out.push({ player, name, metric: 'refused', delta: Number(r.refused) || 0, at });
  }
  return out;
}

/** @type {ReturnType<typeof createLeaderboard> | null} */
let board = null;

/**
 * Built lazily: the module is imported by a route, and `siteUrl()` reads an
 * environment variable Next would otherwise bake in at build time.
 */
export function leaderboard() {
  board ??= createLeaderboard({
    siteName: 'RSS Amplifier',
    siteUrl: siteUrl(),
    basePath: '/leaderboard',
    store: projectionStore({ events, badges }),
    sides: { buy: 'Agents paying', use: 'Agents asking' },
    boards: {
      spenders: { label: 'Biggest spenders', metric: 'spent', format: 'usd', unit: 'Spent', side: 'buy', actor: 'Agent' },
      passes: { label: 'Most passes bought', metric: 'passes', format: 'integer', unit: 'Passes', side: 'buy', actor: 'Agent' },
      days: { label: 'Most days of access', metric: 'days', format: 'integer', unit: 'Days', side: 'buy', actor: 'Agent' },
      busiest: { label: 'Most requests', metric: 'hits', format: 'integer', unit: 'Requests', side: 'use', actor: 'Agent' },
      refused: { label: 'Most requests refused', metric: 'refused', format: 'integer', unit: 'Refused', side: 'use', actor: 'Agent' },
    },
    // Nobody earns here: the directory sells access to its own index.
    ladder: null,
    cacheMs: 60_000,
  });
  return board;
}
