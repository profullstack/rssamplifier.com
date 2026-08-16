import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../lib/db.js';
import { CHUNK_SIZE, chunkFilename, esc } from '../../lib/sitemap.js';

export const dynamic = 'force-dynamic';

/**
 * A sitemap index, not a sitemap.
 *
 * This used to be a single file capped at 20,000 URLs, which hid roughly 27,700
 * blog pages from every search engine. The cap could not simply be raised: the
 * directory is already within reach of the spec's 50,000-URL ceiling for one
 * file, so the next import would have put it right back here.
 *
 * The directory is split instead, into chunk files under /sitemaps/ grouped by
 * the month each blog was added. A month that has passed never changes shape
 * again — a blog submitted today lands in this month's file and leaves every
 * earlier one untouched — so a crawler can skip what it already has on the
 * strength of <lastmod> alone.
 */
export async function GET() {
  const base = siteUrl();
  const chunks = await q.sitemapChunks(db(), CHUNK_SIZE);

  const entries = [
    `  <sitemap><loc>${esc(`${base}/sitemaps/static.xml`)}</loc></sitemap>`,
    ...chunks.map((chunk) => {
      const loc = `${base}/sitemaps/${chunkFilename(chunk)}`;
      const lastmod = chunk.lastmod ? `<lastmod>${esc(chunk.lastmod)}</lastmod>` : '';
      return `  <sitemap><loc>${esc(loc)}</loc>${lastmod}</sitemap>`;
    }),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</sitemapindex>
`;

  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  });
}
