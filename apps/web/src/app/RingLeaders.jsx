import { webrings } from '@rssamplifier/db';

import { db } from '../lib/db.js';

const TTL_MS = 5 * 60 * 1000;

/** @type {{ at: number, rows: Array<{ slug: string, title: string, likes: number, active_count: number }> }} */
let cache = { at: 0, rows: [] };

/**
 * The footer's line of rings: the five people like most, and the doors to
 * the full leaderboard and to making one. On every page, so it is one
 * query per worker per five minutes, and a page never waits on a failure.
 */
export default async function RingLeaders() {
  if (Date.now() - cache.at > TTL_MS) {
    try {
      cache = { at: Date.now(), rows: await webrings.topRings(db(), 5) };
    } catch {
      cache = { at: Date.now(), rows: [] };
    }
  }
  const rows = cache.rows;

  return (
    <p>
      {rows.length ? 'Top rings: ' : 'Rings: '}
      {rows.map((r, i) => (
        <span key={r.slug}>
          {i > 0 && ' · '}
          <a href={`/ring/${encodeURIComponent(r.slug)}`}>{r.title}</a>
          {r.likes > 0 && <span className="meta"> {r.likes} ♥</span>}
        </span>
      ))}
      {rows.length ? ' · ' : ''}
      <a href="/ring/leaders">Leaders</a> · <a href="/ring/new">Make a ring</a>
    </p>
  );
}
