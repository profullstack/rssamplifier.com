import { submitMany, submitOpml, hashIp } from '@rssamplifier/ingest';
import { q } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
  /** @type {{ accepted: any[], rejected: any[] }} */
  let result;

  try {
    if (contentType.includes('application/json')) {
      const body = await req.json();

      if (typeof body?.opml === 'string') {
        kind = 'opml';
        raw = body.opml;
        result = await submitOpml(client, raw);
      } else {
        const urls = Array.isArray(body?.urls) ? body.urls : splitUrls(body?.url);
        raw = urls.join('\n');
        kind = urls.length > 1 ? 'list' : 'url';
        result = await submitMany(client, urls);
      }
    } else {
      const form = await req.formData();
      const file = form.get('opml');

      if (file && typeof file !== 'string' && file.size > 0) {
        kind = 'opml';
        raw = await file.text();
        result = await submitOpml(client, raw);
      } else {
        raw = String(form.get('input') ?? '');
        const urls = splitUrls(raw);
        kind = urls.length > 1 ? 'list' : 'url';
        result = await submitMany(client, urls);
      }
    }
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  await q.insertSubmission(client, {
    kind,
    raw_input: raw.slice(0, 10_000),
    accepted_count: result.accepted.length,
    rejected_count: result.rejected.length,
    errors: result.rejected,
    ip_hash: ipHash,
    user_agent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
  });

  // A browser form post gets a redirect; an agent or curl gets JSON.
  if ((req.headers.get('accept') ?? '').includes('text/html')) {
    const first = result.accepted[0];
    return new Response(null, {
      status: 303,
      headers: { location: first ? `/${first.slug}` : '/submit?error=1' },
    });
  }

  return json({
    ok: result.accepted.length > 0,
    accepted: result.accepted,
    rejected: result.rejected,
  });
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
