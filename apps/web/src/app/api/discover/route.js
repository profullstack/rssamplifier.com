import { discoverFromKeywords, hashIp } from '@rssamplifier/ingest';
import { parseKeywords, MAX_KEYWORDS, apiKey } from '@rssamplifier/search';
import { discovery, newId } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Discovery runs allowed per IP per hour, and keywords across them.
 *
 * Tighter than /api/submit's limit because this endpoint spends money: every
 * keyword is a credit against a metered monthly search plan. The keyword cap is
 * the one that actually binds — one run of a hundred keywords is the whole
 * hourly budget.
 */
const RATE_LIMIT_RUNS = 5;
const RATE_LIMIT_KEYWORDS = 200;

/**
 * Find blogs by keyword.
 *
 * Searches the web for each keyword, collects the sites, resolves feeds and
 * keeps the ones worth keeping. What does not fit in the request is queued for
 * the poller, and the caller gets a status URL either way.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const client = db();
  const contentType = req.headers.get('content-type') ?? '';

  // Answering "no key configured" up front is worth a branch: without it the
  // run is created, fails every search, and the submitter reads a status page
  // that says a hundred searches failed for reasons it cannot explain.
  if (!apiKey()) {
    return json({ ok: false, error: 'search-unavailable' }, 503);
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    null;
  const ipHash = hashIp(ip, process.env['IP_HASH_SALT']);

  let raw = '';
  let email = null;

  try {
    if (contentType.includes('application/json')) {
      const body = await req.json();
      email = normalizeEmail(body?.email);
      raw = Array.isArray(body?.keywords)
        ? body.keywords.join('\n')
        : String(body?.keyword ?? body?.q ?? '');
    } else {
      const form = await req.formData();
      email = normalizeEmail(form.get('email'));
      raw = String(form.get('keywords') ?? form.get('keyword') ?? '');
    }
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const keywords = parseKeywords(raw);
  if (keywords.length === 0) {
    if (wantsHtml(req)) return redirect('/discover?error=empty');
    return json({ ok: false, error: 'no-keywords' }, 400);
  }

  if (ipHash) {
    const used = await discovery.runCount(client, ipHash);
    if (used.runs >= RATE_LIMIT_RUNS || used.keywords + keywords.length > RATE_LIMIT_KEYWORDS) {
      if (wantsHtml(req)) return redirect('/discover?error=rate');
      return json({ ok: false, error: 'rate-limited', retryAfterSeconds: 3600 }, 429);
    }
  }

  const runId = newId();
  const browser = wantsHtml(req);

  // A browser is sent to the status page the moment the run exists, rather than
  // holding the form open for the inline budget — up to eighty-five seconds of
  // blank tab, which is the whole reason this page felt broken. The status page
  // streams the same work as it happens, so nothing is hidden by answering
  // early; it is only shown somewhere better.
  //
  // An agent still gets the finished counts in one call. That is the documented
  // contract of this endpoint and the reason curl works at all.
  let started;
  let begun = false;
  const ready = new Promise((resolve) => {
    started = resolve;
  });

  const work = discoverFromKeywords(client, keywords, {
    runId,
    notifyEmail: email,
    ipHash,
    userAgent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
    onStarted: () => {
      begun = true;
      started();
    },
  });

  if (browser) {
    // Nothing awaits `work` after this, so its failures have to be caught here
    // or they surface as an unhandled rejection and take the process with it.
    // Racing rather than plainly awaiting `ready` matters: if the run cannot be
    // created at all, that signal never comes and the request would hang until
    // the client gave up.
    const settled = work.catch(() => null);
    await Promise.race([ready, settled]);

    if (!begun) return redirect('/discover?error=failed');
    return redirect(`/discoveries/${runId}`);
  }

  const result = await work;

  return json({
    ok: result.error === null || result.searched > 0,
    runId,
    statusUrl: `${siteUrl()}/discoveries/${runId}`,
    keywords,
    searched: result.searched,
    candidates: result.candidates,
    accepted: result.accepted,
    rejected: result.rejected,
    queuedKeywords: result.queuedKeywords,
    queuedCandidates: result.queuedCandidates,
    error: result.error,
  });
}

/**
 * How many keywords a run may carry, for anything building a form or a client.
 */
export async function GET() {
  return json({
    ok: true,
    maxKeywords: MAX_KEYWORDS,
    available: Boolean(apiKey()),
    post: {
      keywords: ['siberian huskies'],
      email: 'optional@example.com',
    },
  });
}

/**
 * @param {Request} req
 * @returns {boolean}
 */
function wantsHtml(req) {
  return (req.headers.get('accept') ?? '').includes('text/html');
}

/**
 * @param {string} location
 * @returns {Response}
 */
function redirect(location) {
  return new Response(null, { status: 303, headers: { location } });
}

/**
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
