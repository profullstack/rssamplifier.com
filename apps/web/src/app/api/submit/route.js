import { submitCatalogue, submitOpml, submitOpmlStream, hashIp } from '@rssamplifier/ingest';
import { OpmlTooLargeError } from '@rssamplifier/feed';
import { q, newId } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { clampRawInput, rawInputCollector } from '../../../lib/submitted.js';
import {
  OPML_MAX_BYTES,
  isRawOpmlUpload,
  multipartFile,
  rawBodyChunks,
  teeHead,
} from '../../../lib/upload.js';

export const dynamic = 'force-dynamic';

// An upload is now bounded by how long it takes to arrive rather than by how
// much of it fits in memory, so the time budget is the one that has to give. At
// the ceiling this is still not enough — ten gibibytes needs a very fast client
// — but self-hosted Next treats this as advisory anyway, and the number should
// say what the endpoint is for.
export const maxDuration = 3600;

/** Submissions allowed per IP per hour. */
const RATE_LIMIT = 20;

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

  const audit = {
    ip_hash: ipHash,
    user_agent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
  };

  // A file upload never becomes a string, so it takes its own path out of here
  // rather than joining the one below. Everything the two share — the rate
  // limit above, the response shapes below — is shared; what differs is that
  // this one has nothing in hand yet and must not wait until it does.
  if (contentType.includes('multipart/form-data')) {
    const part = await multipartFile(req, contentType).catch(() => null);
    if (!part) return json({ ok: false, error: 'bad-request' }, 400);

    // The upload form carries no textarea, so a submit with no file chosen is
    // an empty part rather than a list to fall back to.
    return streamedOpml(req, {
      client,
      submissionId,
      audit,
      chunks: part.chunks,
      email: async () => normalizeEmail((await part.fields).email),
    });
  }

  if (isRawOpmlUpload(contentType)) {
    // For a client that has no reason to wrap a file in a form. The body is the
    // document, so there is nothing to parse before the scan begins.
    const url = new URL(req.url);
    return streamedOpml(req, {
      client,
      submissionId,
      audit,
      chunks: rawBodyChunks(req),
      email: async () => normalizeEmail(url.searchParams.get('email')),
    });
  }

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
      // Whatever is left is the paste box, which posts urlencoded. A file can
      // no longer arrive here: multipart went to the streaming path above.
      const form = await req.formData();
      email = normalizeEmail(form.get('email'));

      raw = String(form.get('input') ?? '');
      const urls = splitUrls(raw);
      kind = urls.length > 1 ? 'list' : 'url';
      entries = urls.map((url) => ({ url }));
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
    raw_input: clampRawInput(raw),
    ...audit,
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
 * Take an OPML upload that is still arriving.
 *
 * The ordering here is the whole design, and it is not the obvious one.
 *
 * The submission row is written *before* the body is read, with no input in it,
 * because an import that runs for an hour needs a status page for the hour it
 * is running rather than after. The stored copy of the upload is filled in the
 * moment enough of it has gone past — a separate, tiny update — so the "what
 * you submitted" section is there while it matters. And the email address is
 * fetched last, because a browser sends form fields in document order and the
 * file input sits above the email one: there is no address to read until the
 * file has been drained.
 *
 * @param {Request} req
 * @param {{
 *   client: import('@libsql/client').Client,
 *   submissionId: string,
 *   audit: { ip_hash: string|null, user_agent: string|null },
 *   chunks: AsyncIterable<Uint8Array|string>,
 *   email: () => Promise<string|null>,
 * }} ctx
 */
async function streamedOpml(req, ctx) {
  const { client, submissionId, chunks } = ctx;

  await q.insertSubmission(client, {
    id: submissionId,
    kind: 'opml',
    raw_input: '',
    ...ctx.audit,
  });

  const head = rawInputCollector();
  let stored = false;

  /** Write the stored copy once, as soon as there is a whole one to write. */
  const store = async () => {
    if (stored) return;
    stored = true;
    await q.setSubmissionInput(client, submissionId, head.value()).catch(() => {});
  };

  const watched = teeHead(chunks, (text) => {
    const more = head.add(text);
    // Fire-and-forget: the import must not wait on the audit trail.
    if (!more) void store();
    return more;
  });

  let resolveQueued;
  const queuedCount = new Promise((resolve) => {
    resolveQueued = resolve;
  });

  const work = submitOpmlStream(client, watched, {
    submissionId,
    maxBytes: OPML_MAX_BYTES,
    onQueued: (n) => resolveQueued(n),
  })
    .then(async (result) => {
      // For an upload smaller than the cap the head never filled, so this is
      // where the stored copy gets written.
      await store();

      const email = await ctx.email();
      await q.completeSubmission(client, submissionId, {
        accepted_count: result.accepted.length,
        rejected_count: result.rejected.length,
        queued_count: result.queued,
        notify_email: result.queued > 0 ? email : null,
        errors: result.rejected,
      });
      return result;
    })
    .catch(async (err) => {
      // A refused or broken upload still queued whatever arrived before it
      // stopped, and the status page is the only place that can say so.
      await store();
      await q
        .completeSubmission(client, submissionId, {
          errors: [{ url: '', error: String(err?.message ?? err) }],
        })
        .catch(() => {});
      throw err;
    });

  const browser = (req.headers.get('accept') ?? '').includes('text/html');

  if (browser) {
    const settled = work.catch(() => null);
    const queued = await Promise.race([queuedCount, settled.then(() => 0)]);

    if (queued > 0) {
      return new Response(null, {
        status: 303,
        headers: { location: `/submissions/${submissionId}` },
      });
    }

    // Nothing queued and nothing resolved is the empty-form case — the file
    // input was left untouched, or the document had no outlines in it. That
    // belongs back on the form with its error showing, not on a status page
    // reporting zero of zero.
    const result = await settled;
    const first = result?.accepted?.[0];
    const location = first ? `/${first.slug}` : '/submit?error=1';

    return new Response(null, { status: 303, headers: { location } });
  }

  try {
    const result = await work;

    return json({
      ok: result.accepted.length > 0 || result.queued > 0,
      accepted: result.accepted,
      rejected: result.rejected,
      queued: result.queued,
      total: result.total,
      submissionId,
      statusUrl: `${siteUrl()}/submissions/${submissionId}`,
    });
  } catch (err) {
    if (err instanceof OpmlTooLargeError) {
      return json(
        { ok: false, error: 'too-large', maxBytes: err.limit, submissionId },
        413,
      );
    }
    return json({ ok: false, error: 'bad-request', submissionId }, 400);
  }
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
