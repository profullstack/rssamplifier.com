import { q } from '@rssamplifier/db';

import { db } from '../../../../lib/db.js';
import {
  MAX_BATCH_ENTRIES,
  MAX_UPLOAD_FEEDS,
  checkUploadAccess,
  ipHashOf,
  json,
} from '../../../../lib/upload.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Record one slice of an upload, without queueing any of it.
 *
 * The difference between this and `/api/submit/batch` is the whole point of it.
 * `batch` does the import: it looks up which URLs are known, claims a slug for
 * every new one, and writes the rows. That is real work, several seconds of it,
 * and it happens several hundred times for a large catalogue — so the tab that
 * started the upload had to stay open for the entire import, half an hour or
 * more, or lose it.
 *
 * This writes down what it was given and returns. One insert, no lookups, no
 * slugs, nothing that depends on the size of the directory. Handing over a
 * 620,000-entry catalogue becomes a minute of requests instead of half an hour
 * of them, and the tab can be closed the moment the last one lands: the poller
 * drains what was staged, and `/submissions/<id>` reports it either way.
 *
 * The trade is that a staged entry is not yet a feed, so the status page has to
 * say "waiting to be queued" for a while. That is a better thing to look at
 * than a progress bar you are not allowed to walk away from.
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

  // Counted as the client reports it, the same way `batch` takes its offset on
  // trust: this bounds one submission, and a client that lies about it only
  // bounds its own.
  const offset = Math.max(0, Math.floor(Number(body?.offset ?? 0)) || 0);
  if (offset >= MAX_UPLOAD_FEEDS) {
    return json({ ok: false, error: 'too-many-feeds', maxFeeds: MAX_UPLOAD_FEEDS }, 413);
  }

  // Only entries with something url-shaped are worth storing; the rest are
  // counted so the totals still add up to what was sent.
  const usable = [];
  let invalid = 0;
  for (const entry of entries) {
    const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
    if (!url) {
      invalid += 1;
      continue;
    }
    usable.push({ url, title: entry?.title ?? null, siteUrl: entry?.siteUrl ?? null });
  }

  const staged = await q.stageImportEntries(client, id, usable);

  return json({ ok: true, staged, invalid, total: entries.length });
}
