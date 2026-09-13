import { siteUrl } from '../../../../lib/db.js';
import { checkMemberNow, loadRing } from '../../../../lib/rings.js';
import { findMember, memberEntry, ringUrl } from '../../../../lib/openwebring.js';

export const dynamic = 'force-dynamic';

/**
 * POST /ring/<slug>/check?url=<member site>: check one member now.
 *
 * For the member who has just pasted the snippet. The poller looks at every
 * member about once a week, which is right for a ring and wrong for a person
 * waiting to see their link work; this runs the same check for one site on
 * demand. Behind the page gate, because it fetches a stranger's page inside
 * a request, and rate-limited by the proxy like everything else here.
 *
 * The `url` may also arrive as a form field or a JSON body. A form is sent
 * back to the ring page with the outcome in the query; anything else gets
 * JSON.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function POST(req, { params }) {
  const { slug } = await params;
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');
  const back = (query) => {
    const page = ringUrl(siteUrl(), slug);
    return new Response(null, { status: 303, headers: { location: `${page}?${query}` } });
  };

  const loaded = await loadRing(slug);
  if (!loaded) return wantsHtml ? back('status=unknown') : json({ error: 'not-found', slug }, 404);

  const url = await memberUrl(req);
  if (!url) return wantsHtml ? back('status=unknown') : json({ error: 'url is required' }, 400);

  const member = findMember(loaded.members, { url });
  if (!member) {
    return wantsHtml
      ? back(`checked=${encodeURIComponent(url)}&status=unknown`)
      : json({ error: 'not-a-member', ring: loaded.ring.slug, url }, 404);
  }

  const outcome = await checkMemberNow(loaded, member);
  if (!outcome) {
    return wantsHtml
      ? back(`checked=${encodeURIComponent(member.member_slug)}&status=busy`)
      : new Response(JSON.stringify({ error: 'busy', hint: 'The checker is busy right now. Try again in a moment.' }, null, 2), {
          status: 503,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
            'retry-after': '10',
          },
        });
  }

  if (wantsHtml) return back(`checked=${encodeURIComponent(member.member_slug)}&status=${outcome.status}`);

  const after = (await loadRing(slug))?.members.find((m) => m.feed_id === member.feed_id) ?? member;
  return json({
    ok: true,
    ring: loaded.ring.slug,
    member: memberEntry(after),
    status: outcome.status,
    // Which of the two things the check looks for was found: a link on the
    // page, the ring named in the site's descriptor, or neither.
    linked: outcome.result.linked,
    reachable: outcome.result.reachable,
  });
}

/**
 * The member URL, from the query, a form field or a JSON body.
 *
 * @param {Request} req
 * @returns {Promise<string|null>}
 */
async function memberUrl(req) {
  const fromQuery = new URL(req.url).searchParams.get('url')?.trim();
  if (fromQuery) return fromQuery;

  const type = req.headers.get('content-type') ?? '';
  try {
    if (type.includes('json')) {
      const body = await req.json();
      return typeof body?.url === 'string' && body.url.trim() ? body.url.trim() : null;
    }
    if (type.includes('form')) {
      const form = await req.formData();
      const value = form.get('url');
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    }
  } catch {
    return null;
  }
  return null;
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
      'cache-control': 'no-store',
    },
  });
}
