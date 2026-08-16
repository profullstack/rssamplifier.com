import { db, siteUrl } from '../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Sitemap covering the static pages and every blog page.
 */
export async function GET() {
  const sb = db();
  const base = siteUrl();

  const { data } = await sb
    .from('feeds')
    .select('slug, updated_at')
    .neq('status', 'dead')
    .order('updated_at', { ascending: false })
    .limit(20000);

  const urls = [
    { loc: base, lastmod: null },
    { loc: `${base}/submit`, lastmod: null },
    { loc: `${base}/search`, lastmod: null },
    { loc: `${base}/about`, lastmod: null },
    ...(data ?? []).map((f) => ({ loc: `${base}/${f.slug}`, lastmod: f.updated_at })),
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
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
