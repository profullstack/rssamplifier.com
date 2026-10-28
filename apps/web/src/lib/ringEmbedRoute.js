import { siteUrl } from './db.js';
import { loadRing } from './rings.js';
import { embedDocument, embedSite, ringEmbed } from './ringEmbed.js';
import { json } from '../app/api/authors/route.js';

/**
 * The embed API behind /api/rings/<slug>/embed and /api/v1/rings/embed.
 *
 *   ?site=https://your.site/   the member homepage hops are measured from
 *   ?style=plain|styled        with ?format=html, which variant to return
 *   ?random=1                  add the ⚄ random-site link
 *   ?format=html               the snippet itself as text/plain, for curl
 *
 * Public, like the ring pages: a snippet is links to public pages.
 *
 * @param {Request} req
 * @param {string[]} slugs
 * @returns {Promise<Response>}
 */
export async function embedResponse(req, slugs) {
  const url = new URL(req.url);
  const rawSite = url.searchParams.get('site');
  const site = rawSite ? embedSite(rawSite) : null;
  if (rawSite && !site) return json({ error: 'bad-site', site: rawSite }, 400);
  if (!slugs.length) return json({ error: 'no-rings', hint: 'pass ?rings=a,b' }, 400);
  if (slugs.length > 10) return json({ error: 'too-many-rings', max: 10 }, 400);

  const rings = [];
  const missing = [];
  for (const slug of slugs) {
    const loaded = await loadRing(slug);
    if (loaded) rings.push({ slug: loaded.ring.slug, title: loaded.ring.title });
    else missing.push(slug);
  }
  if (missing.length) return json({ error: 'not-found', missing }, 404);

  const base = siteUrl();
  const random = ['1', 'true', 'yes'].includes(String(url.searchParams.get('random') ?? ''));

  if (url.searchParams.get('format') === 'html') {
    const style = url.searchParams.get('style') === 'styled' ? 'styled' : 'plain';
    return new Response(`${ringEmbed({ base, rings, site, style, random })}\n`, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=300',
      },
    });
  }
  return json(embedDocument({ base, rings, site, random }));
}

/**
 * Ring slugs from `?rings=a,b` (and repeated `?ring=`), deduplicated.
 *
 * @param {URL} url
 * @returns {string[]}
 */
export function ringsParam(url) {
  const all = [...url.searchParams.getAll('rings'), ...url.searchParams.getAll('ring')]
    .flatMap((v) => v.split(','))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z0-9][a-z0-9-]{0,80}$/.test(s));
  return [...new Set(all)];
}
