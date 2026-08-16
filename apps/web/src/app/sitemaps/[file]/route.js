import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { CHUNK_SIZE, STATIC_PAGES, esc, parseChunkFilename } from '../../../lib/sitemap.js';

export const dynamic = 'force-dynamic';

/**
 * One chunk of the sitemap: /sitemaps/static.xml or /sitemaps/blogs-YYYY-MM.xml.
 *
 * Every file here is listed by the index at /sitemap.xml. A name that is not a
 * chunk 404s rather than being turned into a query, so the shape of the URL is
 * decided here and not by whatever a crawler asks for.
 *
 * @param {Request} request
 * @param {{ params: Promise<{ file: string }> }} ctx
 */
export async function GET(request, ctx) {
  const { file } = await ctx.params;
  const base = siteUrl();

  if (file === 'static.xml') {
    return xml(
      STATIC_PAGES.map(
        (p) =>
          `  <url><loc>${esc(`${base}${p.path}`)}</loc>` +
          `<changefreq>${p.changefreq}</changefreq>` +
          `<priority>${p.priority}</priority></url>`,
      ),
    );
  }

  // Topic pages in one file rather than chunked by month: a topic has no
  // creation date to chunk on — it exists as long as two feeds share it and
  // stops existing when they stop — and the browsable index is capped well
  // under the 50,000-URL limit a single sitemap file allows.
  if (file === 'topics.xml') {
    const topics = await q.topicsForSitemap(db(), CHUNK_SIZE);
    if (topics.length === 0) return new Response('Not found', { status: 404 });

    return xml(
      topics.map((t) => {
        const lastmod = t.refreshed_at ? `<lastmod>${esc(t.refreshed_at)}</lastmod>` : '';
        return `  <url><loc>${esc(`${base}/topics/${encodeURIComponent(String(t.slug))}`)}</loc>${lastmod}</url>`;
      }),
    );
  }

  const chunk = parseChunkFilename(file);
  if (!chunk) return new Response('Not found', { status: 404 });

  const rows = await q.feedsForSitemapChunk(db(), { ...chunk, chunkSize: CHUNK_SIZE });

  // An empty chunk means the name is syntactically valid but describes no part
  // of the directory — a stale URL from an older index, or a guess. 404 keeps it
  // out of a crawler's set rather than handing back a valid, permanently empty
  // sitemap it will keep revisiting.
  if (rows.length === 0) return new Response('Not found', { status: 404 });

  return xml(
    rows.map((f) => {
      const lastmod = f.updated_at ? `<lastmod>${esc(f.updated_at)}</lastmod>` : '';
      return `  <url><loc>${esc(`${base}/${f.slug}`)}</loc>${lastmod}</url>`;
    }),
  );
}

/**
 * @param {string[]} urls rendered <url> elements
 * @returns {Response}
 */
function xml(urls) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;

  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  });
}
