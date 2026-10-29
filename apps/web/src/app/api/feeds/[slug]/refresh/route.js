import { q } from '@rssamplifier/db';
import { crawlFeed } from '@rssamplifier/ingest';
import { isCollected } from '@rssamplifier/social';

import { db } from '../../../../../lib/db.js';

export const dynamic = 'force-dynamic';

/** A feed read this recently is answered from what we have: a click is not a reason to ask the publisher twice. */
const RECENT_MS = 5 * 60_000;

/** How long a click waits on the publisher before it is told the read carries on without it. */
const WAIT_MS = 25_000;

/** Reads this worker has in flight, so a double click is one request to the publisher. */
const inflight = new Map();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });

/**
 * Read one feed now: the refresh button on a feed page (and anyone's agent).
 *
 * The crawler reads every feed on its own schedule, but a schedule is a guess
 * and a reader looking at a stale page knows better. This runs the crawler's
 * own crawlFeed in the request, so what lands is exactly what a scheduled read
 * would have stored, and the cadence it writes is recomputed from the fresh
 * document. Social sources are collected by the poller's runtime, not here, so
 * those are moved to the front of their queue instead.
 *
 * @param {Request} _req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function POST(_req, { params }) {
  const { slug } = await params;
  const client = db();
  const feed = await q.feedBySlug(client, slug);
  if (!feed) return json({ error: 'not-found' }, 404);
  if (feed.status === 'dead') return json({ ok: false, state: 'dead', error: 'This feed has been retired after repeated failures.' }, 409);

  const last = Date.parse(String(feed.last_fetched_at ?? ''));
  if (Number.isFinite(last) && Date.now() - last < RECENT_MS) {
    return json({ ok: true, state: 'recent', checkedAt: new Date(last).toISOString(), newItems: 0 });
  }

  if (isCollected(feed)) {
    await q.requestRefresh(client, String(feed.id));
    return json({ ok: true, state: 'queued' }, 202);
  }

  const id = String(feed.id);
  let run = inflight.get(id);
  if (!run) {
    run = crawlFeed(client, feed)
      .catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
      .finally(() => inflight.delete(id));
    inflight.set(id, run);
  }

  const res = await Promise.race([run, new Promise((resolve) => setTimeout(() => resolve(null), WAIT_MS))]);
  if (res === null) return json({ ok: true, state: 'reading' }, 202);
  if (!res.ok) {
    return json({ ok: false, state: res.throttled ? 'throttled' : 'failed', error: res.error ?? 'The publisher did not answer.' }, 502);
  }

  const after = await q.feedBySlug(client, slug);
  return json({
    ok: true,
    state: res.notModified ? 'unchanged' : 'read',
    newItems: Number(res.newItems ?? 0),
    checkedAt: after?.last_success_at ?? null,
    lastPublishedAt: after?.last_published_at ?? null,
    nextCheckAt: after?.next_fetch_at ?? null,
  });
}
