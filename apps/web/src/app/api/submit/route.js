import { submitCatalogue, hashIp, EXPRESS_MAX } from '@rssamplifier/ingest';
import { parseOpml } from '@rssamplifier/feed';
import { q, newId } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { sniffKind } from '../../../lib/opml-scan.js';
import { clampRawInput } from '../../../lib/submitted.js';

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
 * How much of a file is read before deciding what kind of file it is.
 *
 * The signature that settles it — the `<opml>` root, or the first `<outline>` —
 * is in the first line or two of any real export, so this only has to be past
 * the XML declaration and any comment somebody put above it.
 */
const SNIFF_CHARS = 4096;

/**
 * Entries above which a submission is handed over rather than imported here.
 *
 * Below this a submission is queued entry by entry: a slug is claimed for each
 * one and the rows are written in chunks. That is milliseconds for a paste and
 * minutes for a subscription export — a hundred and ten thousand entries is
 * hundreds of sequential round trips inside a single request with a five-minute
 * ceiling on it, which is a coin toss at best and loses the whole upload when
 * it comes up wrong.
 *
 * Past this the entries are staged instead, exactly as the batched uploader
 * stages them: one bulk insert per couple of thousand, no lookups, no slugs,
 * nothing that scales with the size of the directory, and the poller drains it
 * afterwards. The submitter gets the status page, which is where an import of
 * that size was always going to end up.
 *
 * Below it nothing changes, and that matters more than it sounds: a small
 * submission is resolved over the network while the submitter waits, and one
 * URL still redirects to the blog it just added.
 */
const STAGE_ABOVE = 5_000;

/**
 * Entries written per staging statement.
 *
 * `stageImportEntries` binds four parameters per row, and SQLite's ceiling on
 * bound parameters is what decides this rather than the size of the payload —
 * two thousand rows is eight thousand of them, comfortably under it, and the
 * same slice the uploader and the drainer both work in.
 */
const STAGE_CHUNK = 2_000;

/**
 * How long a single-URL submission is resolved for before the submitter is sent
 * to the status page instead.
 *
 * One URL is still resolved while its submitter waits, because landing on the
 * blog you just added is the nicest thing this page does. What it must not do
 * is wait without a bound: a site that publishes no feed costs up to eleven
 * sequential candidate fetches at a fifteen-second timeout, and the submitter
 * has no way to tell that from a page that has simply hung.
 *
 * Past this the request answers with the status page and the resolve carries on
 * in the background — the same promise, so the feed is still inserted exactly
 * once and there is no queued duplicate racing it.
 */
const INLINE_WAIT_MS = Number(process.env['SUBMIT_INLINE_WAIT_MS'] ?? 8_000) || 8_000;

/** Returned by the race below when the inline resolve outlived its budget. */
const TOO_SLOW = Symbol('too-slow');

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
        raw = await file.text();

        // What the file is, rather than what the field is called. The input is
        // named `opml` because that is what it was built for, but a plain list
        // of feed URLs is the other half of what this page accepts and arrives
        // through the same field — and reading one as the other finds no
        // outlines at all, so a perfectly good subscription list was answered
        // with `no-feeds-in-opml` and nothing was imported. The browser has
        // sniffed its own uploads since the batched uploader landed; this is
        // the same call, for the clients that do not run it.
        if (sniffKind({ name: file.name }, raw.slice(0, SNIFF_CHARS)) === 'opml') {
          kind = 'opml';
          opml = raw;
        } else {
          const urls = splitUrls(raw);
          kind = urls.length > 1 ? 'list' : 'url';
          entries = urls.map((url) => ({ url }));
        }
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
    raw_input: clampRawInput(raw),
    ip_hash: ipHash,
    user_agent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
  });

  const browser = (req.headers.get('accept') ?? '').includes('text/html');

  // An OPML document becomes its entries here rather than inside `submitOpml`,
  // because how many of them there are is what decides what happens next.
  const catalogue = opml === null ? entries : parseOpml(opml);

  // A file that parsed as OPML and holds no outlines is the one failure worth
  // naming: it is almost always the wrong file, and "nothing happened" is a
  // much worse answer than saying so.
  if (opml !== null && catalogue.length === 0) {
    const rejected = [{ url: '', error: 'no-feeds-in-opml' }];

    await q.completeSubmission(client, submissionId, {
      accepted_count: 0,
      rejected_count: 1,
      queued_count: 0,
      notify_email: null,
      errors: rejected,
    });

    if (browser) {
      return new Response(null, { status: 303, headers: { location: '/submit?error=1' } });
    }

    return json({
      ok: false,
      accepted: [],
      rejected,
      queued: 0,
      total: 0,
      submissionId,
      statusUrl: `${siteUrl()}/submissions/${submissionId}`,
    });
  }

  // Too big to crawl inside this request, so it is handed over instead: staged
  // in bulk and released to the poller, which is what the batched uploader has
  // done since it landed. This is the same handover for everyone who is not
  // running it — a client with JavaScript off, curl, an agent posting JSON.
  if (catalogue.length > STAGE_ABOVE) {
    const staged = await stageAll(client, submissionId, catalogue);

    await q.markImportReady(client, submissionId, {
      entries_total: staged,
      rejected_count: catalogue.length - staged,
      // Nobody is owed a notification about an upload that staged nothing, for
      // the reason `completeSubmission` documents: an address on a submission
      // with no pending work reads as a finished import and is mailed at once.
      notify_email: staged > 0 ? email : null,
    });

    if (browser) {
      return new Response(null, {
        status: 303,
        headers: { location: `/submissions/${submissionId}` },
      });
    }

    return json({
      ok: staged > 0,
      accepted: [],
      rejected: [],
      queued: 0,
      // Staged, not queued: these are recorded and waiting for the poller to
      // turn them into feeds, and the status page reports them as such.
      pending: staged,
      total: catalogue.length,
      submissionId,
      statusUrl: `${siteUrl()}/submissions/${submissionId}`,
    });
  }

  let resolveQueued;
  const queuedCount = new Promise((resolve) => {
    resolveQueued = resolve;
  });

  const opts = {
    submissionId,
    // Small enough to have been typed rather than exported, so it goes in the
    // express lane and is crawled within a tick or two instead of behind the
    // backlog. See EXPRESS_MAX.
    priority: catalogue.length <= EXPRESS_MAX ? 1 : 0,
    onQueued: (n) => resolveQueued(n),
  };
  const work = submitCatalogue(client, catalogue, opts).then(async (result) => {
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
    // Anything with a queue behind it is answered the moment that queue is
    // durable, which since submitCatalogue stopped resolving lists inline is
    // every submission of more than one URL. The status page streams the rest.
    const settled = work.catch(() => null);
    const queued = await Promise.race([queuedCount, settled.then(() => 0)]);

    if (queued > 0) {
      return new Response(null, { status: 303, headers: { location: `/submissions/${submissionId}` } });
    }

    // One URL, and it has somewhere better to land than a status page: the blog
    // itself. Bounded, because the resolve behind it is not — see INLINE_WAIT_MS.
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TOO_SLOW), INLINE_WAIT_MS);
    });

    try {
      const result = await Promise.race([settled, deadline]);

      // Still resolving. It carries on in the background and completes the
      // submission when it lands, so the status page is the honest answer now.
      if (result === TOO_SLOW) {
        return new Response(null, {
          status: 303,
          headers: { location: `/submissions/${submissionId}` },
        });
      }

      const first = result?.accepted?.[0];
      // The address the source lives at, which is `/{slug}` for a feed and
      // `/r/programming` or `/x/OpenAI` for a social one. Both render the same
      // page; sending somebody to the slug would land them at the address the
      // namespace exists to replace.
      const location = first ? (first.path ?? `/${first.slug}`) : '/submit?error=1';

      return new Response(null, { status: 303, headers: { location } });
    } finally {
      clearTimeout(timer);
    }
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
 * Write a catalogue into staging, one statement at a time.
 *
 * Entries with nothing url-shaped in them are dropped rather than stored, the
 * same way `/api/submit/stage` drops them: the drainer would only throw them
 * out later, and they would sit in the table until it got round to it. What is
 * dropped is still counted, by the caller, so the totals add up to what arrived.
 *
 * @param {import('@libsql/client').Client} client
 * @param {string} submissionId
 * @param {Array<{ url?: string, title?: string, siteUrl?: string|null }>} catalogue
 * @returns {Promise<number>} rows written
 */
async function stageAll(client, submissionId, catalogue) {
  let staged = 0;

  for (let at = 0; at < catalogue.length; at += STAGE_CHUNK) {
    const slice = catalogue
      .slice(at, at + STAGE_CHUNK)
      .map((entry) => ({
        url: String(entry?.url ?? '').trim(),
        title: entry?.title ?? null,
        siteUrl: entry?.siteUrl ?? null,
      }))
      .filter((entry) => entry.url);

    if (slice.length > 0) staged += await q.stageImportEntries(client, submissionId, slice);
  }

  return staged;
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
