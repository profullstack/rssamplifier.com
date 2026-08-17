import { hashIp } from '@rssamplifier/ingest';
import { q } from '@rssamplifier/db';

/**
 * Feeds one upload may queue.
 *
 * There has to be a number, because the endpoint is open to anyone and a client
 * that keeps posting batches would otherwise keep being served. It is set high
 * enough that the number is never what stops a real catalogue: the largest
 * subscription list anyone has actually uploaded here is 47,000 entries, and a
 * 117 MB OPML is around 700,000.
 */
export const MAX_UPLOAD_FEEDS = Number(process.env['SUBMIT_MAX_FEEDS'] ?? 1_000_000);

/**
 * Entries accepted in one batch request.
 *
 * The uploader picks its own batch size; this is the ceiling, and it exists so
 * that a hand-written client cannot put the whole file back into one request
 * and reintroduce exactly the problem the batching was for.
 */
export const MAX_BATCH_ENTRIES = 5_000;

/**
 * How long a submission stays open for more batches.
 *
 * Long enough for a very large file over a slow connection, short enough that a
 * submission id copied off a status page is not a permanent write token.
 */
export const UPLOAD_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * The hashed address a request came from, or null when it cannot be told.
 *
 * @param {Request} req
 * @returns {string|null}
 */
export function ipHashOf(req) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    null;
  return hashIp(ip, process.env['IP_HASH_SALT']);
}

/**
 * Decide whether this request may add to this submission.
 *
 * Three ways to be told no, and they are worth distinguishing because the
 * uploader shows the reason: the submission was never made, it belongs to
 * somebody else, or it has been open too long to still be an upload in
 * progress.
 *
 * The ownership check is skipped when either side has no address hash, which is
 * the case with `IP_HASH_SALT` unset. That is a deliberate open door rather than
 * a silent lockout: the same condition already disables the rate limiter on the
 * submit endpoint, and failing closed here would mean uploads stop working
 * entirely the moment the salt is missing.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} id
 * @param {string|null} ipHash
 * @returns {Promise<{ ok: true } | { ok: false, error: string, status: number }>}
 */
export async function checkUploadAccess(db, id, ipHash) {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'bad-request', status: 400 };
  }

  const owner = await q.submissionOwner(db, id);
  if (!owner) return { ok: false, error: 'not-found', status: 404 };

  if (owner.ip_hash && ipHash && owner.ip_hash !== ipHash) {
    return { ok: false, error: 'not-yours', status: 403 };
  }

  const age = Date.now() - Date.parse(owner.created_at);
  if (Number.isFinite(age) && age > UPLOAD_WINDOW_MS) {
    return { ok: false, error: 'expired', status: 410 };
  }

  return { ok: true };
}

/**
 * Accept an email address only if it plausibly is one.
 *
 * The same rule the submit endpoint uses, and for the same reason: the only
 * consequence of a bad address is one undeliverable notification, but the empty
 * string a form sends for an untouched field must not become one.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeEmail(value) {
  const email = String(value ?? '')
    .trim()
    .slice(0, 254);
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) ? email : null;
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}
