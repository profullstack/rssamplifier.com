import { siteUrl } from '../../../../lib/db.js';
import { loadRing } from '../../../../lib/rings.js';
import { hopUrl, ringFile } from '../../../../lib/openwebring.js';
import { json } from '../../authors/route.js';

export const dynamic = 'force-dynamic';

/**
 * One ring, as JSON: the ring file plus where its pages are.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { slug } = await params;
  const loaded = await loadRing(slug);
  if (!loaded) return json({ error: 'not-found', slug }, 404);

  const base = siteUrl();
  const file = ringFile({ base, ring: loaded.ring, members: loaded.members });

  return json({
    ...file,
    members: file.members.map((m) => ({
      ...m,
      page: `${base}/${encodeURIComponent(String(m.slug))}`,
      next: hopUrl(base, loaded.ring.slug, 'next', String(m.url)),
      previous: hopUrl(base, loaded.ring.slug, 'previous', String(m.url)),
    })),
    active: loaded.ring.active_count,
    page: file.ring.url,
    opml: `${file.ring.url}/opml`,
    random: hopUrl(base, loaded.ring.slug, 'random'),
    join: `${file.ring.url}#join`,
  });
}
