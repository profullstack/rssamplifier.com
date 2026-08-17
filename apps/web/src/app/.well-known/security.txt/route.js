import { siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * /.well-known/security.txt — RFC 9116.
 *
 * There was no published way to report a vulnerability in a site that accepts
 * arbitrary URLs from strangers and fetches them, which is the kind of site
 * somebody eventually finds something in.
 *
 * Expires is computed on each request rather than written down, because the
 * usual failure of this file is not that it is missing but that it went stale
 * years ago and now says, in machine-readable form, that nobody is reading the
 * address. Six months keeps it inside the year the RFC allows with room to
 * spare if a deploy goes quiet for a while.
 */
export function GET() {
  const expires = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
  const base = siteUrl();

  const body = `Contact: mailto:security@rssamplifier.com
Expires: ${expires}
Preferred-Languages: en
Canonical: ${base}/.well-known/security.txt
Policy: ${base}/privacy
`;

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
