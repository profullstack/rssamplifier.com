import { webrings } from '@rssamplifier/db';

import { db } from '../../../../../lib/db.js';
import { loadRing } from '../../../../../lib/rings.js';
import { findMember } from '../../../../../lib/openwebring.js';
import { voterKey } from '../../../../../lib/ringVotes.js';

export const dynamic = 'force-dynamic';

/**
 * Vote for one member of a ring. No account: the vote link sits in member
 * footers, in front of readers who have never heard of us.
 *
 * `member` is the member's slug, or `from` its site address (what the
 * footer link carries). Throttled by webrings.castRingVote: one vote per
 * address per site per day, and RING_VOTE_HOURLY_CAP votes per address per
 * hour across everything. A POST only, so a crawler or a link prefetcher
 * following the footer link reaches the vote page and casts nothing.
 *
 * A form is sent back to the vote page with the outcome; anything else gets
 * JSON.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function POST(req, { params }) {
  const { slug } = await params;
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  /** @type {any} */
  let body;
  try {
    body = (req.headers.get('content-type') ?? '').includes('application/json')
      ? await req.json()
      : Object.fromEntries((await req.formData()).entries());
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  const loaded = await loadRing(slug);
  if (!loaded) return json({ error: 'not-found', slug }, 404);
  const member = body?.member
    ? findMember(loaded.members, { slug: String(body.member) })
    : findMember(loaded.members, { url: String(body?.from ?? '') });
  if (!member) return json({ error: 'not-a-member', slug }, 404);

  const back = (outcome) =>
    Response.redirect(
      new URL(
        `/ring/${encodeURIComponent(loaded.ring.slug)}/vote?member=${encodeURIComponent(member.member_slug)}&voted=${outcome}`,
        req.url,
      ),
      303,
    );

  const voter = voterKey(req);
  if (!voter) return wantsHtml ? back('unavailable') : json({ error: 'voting-unavailable' }, 503);

  const client = db();
  const outcome = await webrings.castRingVote(client, {
    ringSlug: loaded.ring.slug,
    memberSlug: member.member_slug,
    voter,
  });
  if (wantsHtml) return back(outcome);
  if (outcome === 'throttled') {
    return json({ error: 'throttled', retry_after_seconds: 3600 }, 429, { 'retry-after': '3600' });
  }
  const votes = (await webrings.ringVoteCounts(client, loaded.ring.slug))[member.member_slug] ?? 0;
  return json({ ok: true, ring: loaded.ring.slug, member: member.member_slug, outcome, votes });
}

/**
 * A vote's answer is about this caller at this moment, so nothing may keep it.
 *
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
