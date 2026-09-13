import { profiles } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { profileUrl } from '../../../lib/openprofile.js';
import { json } from '../authors/route.js';

export const dynamic = 'force-dynamic';

/** Most profiles in one page. */
const MAX = 500;

/**
 * Every public author profile, newest change first, for a directory that
 * pulls them (nichedb's profiles collection reads this).
 *
 * `?since=` narrows to profiles changed at or after an ISO stamp, so a puller
 * asks for what moved since its last pass; `?cursor=` continues a page; both
 * compose. An owner who switched their file off is not listed. Keyless, like
 * every read here.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), MAX);
  const since = (url.searchParams.get('since') ?? '').trim() || null;
  const rawCursor = url.searchParams.get('cursor');
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) return json({ error: 'bad-cursor' }, 400);
  if (since && Number.isNaN(Date.parse(since))) return json({ error: 'bad-since' }, 400);

  const rows = await profiles.listOpenProfiles(db(), { since, limit, cursor });
  const base = siteUrl();
  const last = rows[rows.length - 1];

  return json({
    openprofiles: rows.map((r) => ({
      id: r.slug,
      name: r.name,
      url: profileUrl(base, r.slug),
      page: `${base}/authors/${encodeURIComponent(r.slug)}`,
      updatedAt: r.updated_at,
      accounts: r.urls,
      web: r.site_url,
    })),
    next: rows.length === limit && last ? encodeCursor({ updatedAt: last.updated_at, id: last.id }) : null,
  });
}

/**
 * The cursor is the last row's (updated_at, id), which is exactly the keyset
 * the query pages on; opaque to the caller, plain to us.
 *
 * @param {{ updatedAt: string, id: string }} at
 * @returns {string}
 */
export function encodeCursor(at) {
  return Buffer.from(JSON.stringify([at.updatedAt, at.id])).toString('base64url');
}

/**
 * @param {string|null} raw
 * @returns {{ updatedAt: string, id: string }|null}
 */
export function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const [updatedAt, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof updatedAt !== 'string' || typeof id !== 'string' || !updatedAt || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}
