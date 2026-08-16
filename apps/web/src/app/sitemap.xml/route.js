import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Sitemap covering the static pages and every blog page.
 */
export async function GET() {
  const base = siteUrl();
  const rows = await q.allFeedsForExport(db(), 20000);

  const urls = [
    { loc: base, lastmod: null },
    { loc: `${base}/submit`, lastmod: null },
    { loc: `${base}/search`, lastmod: null },
    { loc: `${base}/about`, lastmod: null },
    // Worth crawling: it is the page that answers "can I have an account here".
    // /login is deliberately left out — it is the same form for somebody who
    // already knows the answer, and two entries for one mechanism is the sort
    // of near-duplicate a sitemap should not be volunteering.
    { loc: `${base}/signup`, lastmod: null },
    ...rows.map((f) => ({
      loc: `${base}/${f.slug}`,
      lastmod: f.updated_at ? String(f.updated_at) : null,
    })),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ''}</url>`,
  )
  .join('\n')}
</urlset>
`;

  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
