import { db } from '../../../../lib/db.js';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * What the poller's scraper-daemon is doing, as JSON.
 *
 * The poller has no port of its own, so its daemon writes `daemon.status()`
 * into its own state table once a minute (key 'status' in
 * scraper_daemon_state, see apps/poller/src/daemon.js) and this route reads it
 * back. `ageSeconds` is computed here on every request, never stored: a
 * document that stopped being rewritten is the poller being down, and that is
 * the one fact a cached copy would hide.
 *
 * Same shape as every other site on @profullstack/scraper-daemon, so
 * `npx @profullstack/scraper-daemon status https://rssamplifier.com` reads it.
 */
export async function GET() {
  try {
    const res = await db().execute("SELECT value FROM scraper_daemon_state WHERE key = 'status'");
    const row = res.rows[0];
    if (!row) {
      return Response.json({ error: 'the poller has not reported a status yet' }, { status: 503, headers: NO_STORE });
    }
    const status = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    const ageSeconds = status?.writtenAt ? Math.round((Date.now() - status.writtenAt) / 1000) : null;
    return Response.json({ ...status, ageSeconds }, { headers: NO_STORE });
  } catch (err) {
    // 42P01: the table does not exist until the poller has started once.
    const missing = err?.code === '42P01' || /does not exist/.test(String(err?.message));
    return Response.json(
      { error: missing ? 'the poller has not reported a status yet' : 'status unavailable' },
      { status: 503, headers: NO_STORE },
    );
  }
}
