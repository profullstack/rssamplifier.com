import { q, newId } from '@rssamplifier/db';

import { db, siteUrl } from '../../../../lib/db.js';
import { RAW_INPUT_LIMIT } from '../../../../lib/submitted.js';
import {
  MAX_BATCH_ENTRIES,
  MAX_UPLOAD_FEEDS,
  ipHashOf,
  json,
  normalizeEmail,
} from '../../../../lib/upload.js';

export const dynamic = 'force-dynamic';

/** Submissions allowed per IP per hour — the same budget /api/submit spends from. */
const RATE_LIMIT = 20;

/**
 * Open a submission that will be filled in by later batches.
 *
 * A large upload cannot be one request, so it becomes three kinds of request:
 * this one, which reserves the id and does the rate limiting; a run of batches
 * against that id; and a finish. The whole point of the split is that the
 * client keeps the file and sends the feeds, so nothing here ever sees more
 * than a sample of what is being imported.
 *
 * That sample is not decoration. `/submissions/<id>` names an import by reading
 * the head of what was submitted — the OPML title, the owner, the first few
 * outlines — and an import with nothing stored would be a page of counts with
 * no way to tell which of two uploads it belonged to.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const client = db();
  const ipHash = ipHashOf(req);

  if (ipHash && (await q.submissionCount(client, ipHash)) >= RATE_LIMIT) {
    return json({ ok: false, error: 'rate-limited', retryAfterSeconds: 3600 }, 429);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const kind = body?.kind === 'opml' ? 'opml' : 'list';
  const sample = String(body?.sample ?? '').slice(0, RAW_INPUT_LIMIT);

  const id = newId();
  await q.insertSubmission(client, {
    id,
    kind,
    raw_input: sample,
    ip_hash: ipHash,
    user_agent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
  });

  return json({
    ok: true,
    submissionId: id,
    statusUrl: `${siteUrl()}/submissions/${id}`,
    // Relative as well as absolute: the uploader navigates to it, and doing
    // that through the canonical origin would bounce a visitor on www or on the
    // railway.app host onto a different hostname mid-import.
    statusPath: `/submissions/${id}`,
    // Echoed back so the uploader only promises an email when the address was
    // actually understood, rather than on the strength of the field not being
    // empty.
    email: normalizeEmail(body?.email),
    // Reported rather than assumed, so a client — ours or anybody's — sizes its
    // batches from what the server will take instead of from a guess.
    maxEntriesPerBatch: MAX_BATCH_ENTRIES,
    maxFeeds: MAX_UPLOAD_FEEDS,
  });
}
