import { submitCatalogue, submitOpml, hashIp } from '@rssamplifier/ingest';
import { q, newId } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { RAW_INPUT_LIMIT } from '../../../lib/submitted.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Submissions allowed per IP per hour. */
const RATE_LIMIT = 20;

/**
 * The largest file this endpoint will read in one piece.
 *
 * It reads the upload into a string and then parses it into a document tree, so
 * its memory cost is several times the size of the file — a 117 MB catalogue is
 * hundreds of thousands of nodes held at once, in a web process that is also
 * serving every other visitor. The browser gives up on the upload long before
 * that finishes, so the work is not merely expensive but wasted, and the only
 * thing it reliably achieves is taking the site down for everyone else.
 *
 * Anything larger belongs on /submit, which reads the file in the browser and
 * sends the feeds in batches — no request in that flow is ever more than a few
 * hundred kilobytes. Ten megabytes leaves the whole Kagi small-web catalogue
 * (7.4 MB, 47,000 feeds) inside the direct path.
 */
const INLINE_UPLOAD_LIMIT = Number(process.env['SUBMIT_INLINE_BYTES'] ?? 10_000_000) || 10_000_000;

/**
 * Split a paste into candidate URLs.
 *
 * People separate them with newlines, commas or spaces depending on where they
 * copied from, so all three are treated as delimiters.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function splitUrls(raw) {
  return String(raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Accept a submission: a single URL, a list, or an OPML upload.
 *
 * Open to anyone by design, so the protections are a per-IP rate limit and the
 * SSRF guards inside the fetch layer.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const client = db();
  const contentType = req.headers.get('content-type') ?? '';

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    null;
  const ipHash = hashIp(ip, process.env['IP_HASH_SALT']);

  // Checked against the declared length before the body is read, as well as
  // against the file itself afterwards. Reading a 117 MB multipart body costs
  // the memory whether or not we then refuse it, and the header is the only
  // chance to refuse it for free. The slack covers the multipart envelope and
  // the other fields, which are a few hundred bytes at most.
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > INLINE_UPLOAD_LIMIT + 65_536) {
    return tooLarge(req, declared);
  }

  if (ipHash && (await q.submissionCount(client, ipHash)) >= RATE_LIMIT) {
    return json({ ok: false, error: 'rate-limited', retryAfterSeconds: 3600 }, 429);
  }

  let kind = 'url';
  let raw = '';
  let email = null;
  /** @type {Array<{ url: string, title?: string, siteUrl?: string|null }>} */
  let entries = [];
  let opml = null;

  // The id is minted before the work so the queued feeds can be stamped with it.
  const submissionId = newId();

  try {
    if (contentType.includes('application/json')) {
      const body = await req.json();
      email = normalizeEmail(body?.email);

      if (typeof body?.opml === 'string') {
        kind = 'opml';
        raw = body.opml;
        opml = raw;
      } else {
        const urls = Array.isArray(body?.urls) ? body.urls : splitUrls(body?.url);
        raw = urls.join('\n');
        kind = urls.length > 1 ? 'list' : 'url';
        entries = urls.map((url) => ({ url }));
      }
    } else {
      const form = await req.formData();
      const file = form.get('opml');
      email = normalizeEmail(form.get('email'));

      if (file && typeof file !== 'string' && file.size > 0) {
        if (file.size > INLINE_UPLOAD_LIMIT) return tooLarge(req, file.size);
        kind = 'opml';
        raw = await file.text();
        opml = raw;
      } else {
        raw = String(form.get('input') ?? '');
        const urls = splitUrls(raw);
        kind = urls.length > 1 ? 'list' : 'url';
        entries = urls.map((url) => ({ url }));
      }
    }
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  // Written before the work rather than after it, so that an upload big enough
  // to be worth watching has a status page to be sent to while it is still
  // being worked on. The counts are filled in by completeSubmission; until then
  // they are honestly zero rather than absent.
  await q.insertSubmission(client, {
    id: submissionId,
    kind,
    raw_input: raw.slice(0, RAW_INPUT_LIMIT),
    ip_hash: ipHash,
    user_agent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
  });

  const browser = (req.headers.get('accept') ?? '').includes('text/html');

  let resolveQueued;
  const queuedCount = new Promise((resolve) => {
    resolveQueued = resolve;
  });

  const opts = { submissionId, onQueued: (n) => resolveQueued(n) };
  const work = (
    opml === null ? submitCatalogue(client, entries, opts) : submitOpml(client, opml, opts)
  ).then(async (result) => {
    await q.completeSubmission(client, submissionId, {
      accepted_count: result.accepted.length,
      rejected_count: result.rejected.length,
      queued_count: result.queued,
      // Only stored when there is actually a queue to report on; a submission
      // that finished inline has nothing left to notify anyone about.
      notify_email: result.queued > 0 ? email : null,
      errors: result.rejected,
    });
    return result;
  });

  const statusUrl = `${siteUrl()}/submissions/${submissionId}`;

  if (browser) {
    // An upload with a queue behind it is answered the moment that queue is
    // durable: the status page streams the rest, so waiting for a hundred
    // sequential fetches would buy the submitter nothing but a blank tab.
    const settled = work.catch(() => null);
    const queued = await Promise.race([queuedCount, settled.then(() => 0)]);

    if (queued > 0) {
      return new Response(null, { status: 303, headers: { location: `/submissions/${submissionId}` } });
    }

    // A handful of URLs resolves in seconds and has somewhere better to land:
    // the blog itself. Nothing is gained by bouncing that through a status page.
    const result = await settled;
    const first = result?.accepted?.[0];
    const location = first ? `/${first.slug}` : '/submit?error=1';

    return new Response(null, { status: 303, headers: { location } });
  }

  const result = await work;

  return json({
    ok: result.accepted.length > 0 || result.queued > 0,
    accepted: result.accepted,
    rejected: result.rejected,
    queued: result.queued,
    total: result.total,
    submissionId,
    statusUrl,
  });
}

/**
 * Refuse an upload this endpoint cannot read in one piece.
 *
 * A browser is sent back to the form, because the answer is not "your file is
 * wrong" but "use the uploader on that page" — which is what the form does by
 * itself when JavaScript is on, so anyone who lands here has it off and needs
 * telling in words. An agent gets the size it exceeded and the endpoints that
 * take a file of that size instead.
 *
 * @param {Request} req
 * @param {number} bytes
 * @returns {Response}
 */
function tooLarge(req, bytes) {
  if ((req.headers.get('accept') ?? '').includes('text/html')) {
    return new Response(null, { status: 303, headers: { location: '/submit?error=large' } });
  }

  return json(
    {
      ok: false,
      error: 'file-too-large',
      bytes,
      maxBytes: INLINE_UPLOAD_LIMIT,
      use: ['/api/submit/begin', '/api/submit/batch', '/api/submit/finish'],
    },
    413,
  );
}

/**
 * Accept an email address only if it plausibly is one.
 *
 * Deliberately loose — the only consequence of a bad address here is one
 * undeliverable notification — but it must reject the empty string a form
 * sends for an untouched field.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeEmail(value) {
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
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}
