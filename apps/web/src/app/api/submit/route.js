import { submitMany, submitOpml, hashIp } from '@rssamplifier/ingest';

import { db } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Submissions allowed per IP per hour. */
const RATE_LIMIT = 20;

/**
 * Split a textarea paste into candidate URLs.
 *
 * People separate them with newlines, commas or spaces depending on where they
 * copied from, so all three are treated as delimiters.
 *
 * @param {string} raw
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
 * Open to anyone by design, so the protections are rate limiting by hashed IP
 * and the SSRF guards inside the fetch layer.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const sb = db();
  const contentType = req.headers.get('content-type') ?? '';

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    null;
  const ipHash = hashIp(ip, process.env['IP_HASH_SALT']);

  if (ipHash) {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await sb
      .from('submissions')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', since);

    if ((count ?? 0) >= RATE_LIMIT) {
      return json({ ok: false, error: 'rate-limited', retryAfterSeconds: 3600 }, 429);
    }
  }

  /** @type {string} */ let kind = 'url';
  /** @type {string} */ let raw = '';
  /** @type {{accepted: any[], rejected: any[]}} */ let result;

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('opml');

      if (file && typeof file !== 'string') {
        kind = 'opml';
        raw = await file.text();
        result = await submitOpml(sb, raw);
      } else {
        raw = String(form.get('input') ?? '');
        const urls = splitUrls(raw);
        kind = urls.length > 1 ? 'list' : 'url';
        result = await submitMany(sb, urls);
      }
    } else if (contentType.includes('application/json')) {
      const body = await req.json();

      if (typeof body?.opml === 'string') {
        kind = 'opml';
        raw = body.opml;
        result = await submitOpml(sb, raw);
      } else {
        const urls = Array.isArray(body?.urls) ? body.urls : splitUrls(body?.url ?? '');
        raw = urls.join('\n');
        kind = urls.length > 1 ? 'list' : 'url';
        result = await submitMany(sb, urls);
      }
    } else {
      const form = await req.formData();
      raw = String(form.get('input') ?? '');
      const urls = splitUrls(raw);
      kind = urls.length > 1 ? 'list' : 'url';
      result = await submitMany(sb, urls);
    }
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  await sb.from('submissions').insert({
    kind,
    raw_input: raw.slice(0, 10_000),
    accepted_count: result.accepted.length,
    rejected_count: result.rejected.length,
    errors: result.rejected,
    ip_hash: ipHash,
    user_agent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
  });

  // A browser form post gets a redirect; an agent or curl gets JSON.
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');
  if (wantsHtml) {
    const first = result.accepted[0];
    const to = first ? `/${first.slug}` : '/submit?error=1';
    return new Response(null, { status: 303, headers: { location: to } });
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
