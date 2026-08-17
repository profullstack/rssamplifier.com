import { q, authors } from '@rssamplifier/db';

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
  const client = db();
  const [chunks, topics, people] = await Promise.all([
    q.sitemapChunks(client, CHUNK_SIZE),
    q.countTopics(client),
    authors.countAuthors(client, { minConfidence: 0.6 }),
  ]);

  const entries = [
    `  <sitemap><loc>${esc(`${base}/sitemaps/static.xml`)}</loc></sitemap>`,
    // Listed only once there is something in it: the chunk route 404s an empty
    // topics file, and an index pointing at a 404 is an error in every
    // crawler's report of the site.
    ...(topics > 0 ? [`  <sitemap><loc>${esc(`${base}/sitemaps/topics.xml`)}</loc></sitemap>`] : []),
    // Same rule for the same reason: until the enrichment pass has found
    // somebody, /sitemaps/authors.xml 404s and must not be advertised.
    ...(people > 0 ? [`  <sitemap><loc>${esc(`${base}/sitemaps/authors.xml`)}</loc></sitemap>`] : []),
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
