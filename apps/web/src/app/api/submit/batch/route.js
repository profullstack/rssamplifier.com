import { queueFeeds } from '@rssamplifier/ingest';

import { db } from '../../../../lib/db.js';
import {
  MAX_BATCH_ENTRIES,
  MAX_UPLOAD_FEEDS,
  checkUploadAccess,
  ipHashOf,
  json,
} from '../../../../lib/upload.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Feeds scheduled per minute across a whole upload.
 *
 * Read here rather than in the queue itself so the rate is one number for the
 * deployment, tunable next to POLL_BATCH_SIZE — the two describe the same
 * thing from opposite ends, and a queue that fills faster than the poller
 * drains it is a backlog wearing a progress bar.
 */
const QUEUE_RATE = Number(process.env['QUEUE_FEEDS_PER_MINUTE'] ?? 240) || 240;

/**
 * Queue one slice of an upload.
 *
 * Called several hundred times for a large catalogue, so the only thing that
 * really matters about it is that its cost depends on the slice and not on the
 * directory — see `queueFeeds`, which is where that is arranged.
 *
 * Nothing is fetched. A submitted URL normally gets resolved over the network
 * before it is stored, which is right for one blog and impossible for seven
 * hundred thousand; these land as `pending` with whatever title the catalogue
 * gave them, and the poller replaces that the first time it crawls each one.
 * Watching it happen is what `/submissions/<id>` is for.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const client = db();

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const id = String(body?.submissionId ?? '');
  const access = await checkUploadAccess(client, id, ipHashOf(req));
  if (!access.ok) return json({ ok: false, error: access.error }, access.status);

  const entries = Array.isArray(body?.entries) ? body.entries : null;
  if (!entries) return json({ ok: false, error: 'bad-request' }, 400);
  if (entries.length > MAX_BATCH_ENTRIES) {
    return json({ ok: false, error: 'batch-too-large', maxEntriesPerBatch: MAX_BATCH_ENTRIES }, 413);
  }

  // How much of the upload came before this batch, as the client counts it. It
  // decides only when these feeds are scheduled to be crawled, so a client that
  // lies about it moves its own place in the queue and nothing else — which is
  // why it is taken on trust rather than counted with another query per batch.
  const offset = Math.max(0, Math.floor(Number(body?.offset ?? 0)) || 0);
  if (offset >= MAX_UPLOAD_FEEDS) {
    return json({ ok: false, error: 'too-many-feeds', maxFeeds: MAX_UPLOAD_FEEDS }, 413);
  }

  const result = await queueFeeds(client, entries, {
    submissionId: id,
    offsetMinutes: offset / QUEUE_RATE,
    ratePerMinute: QUEUE_RATE,
  });

  return json({
    ok: true,
    queued: result.queued,
    skipped: result.skipped,
    invalid: result.invalid,
    total: result.total,
  });
}
