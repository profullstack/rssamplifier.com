import { webrings } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { SPEC, hostEntry } from '../../../lib/openwebring.js';
import { json } from '../authors/route.js';

export const dynamic = 'force-dynamic';

/**
 * The rings this site hosts, as JSON.
 *
 * The same entries as /.well-known/openwebring.json, with the page and the
 * API address of each ring added, and the active count beside the listed
 * count so a caller can see how much of a ring is live without fetching
 * every ring file.
 */
export async function GET() {
  const base = siteUrl();
  const rings = await webrings.listRings(db());

  return json({
    total: rings.length,
    host: `${base}/.well-known/openwebring.json`,
    spec: SPEC,
    rings: rings.map((ring) => ({
      ...hostEntry({ base, ring }),
      active: ring.active_count,
      kind: ring.kind,
      ...(ring.topic_slug ? { topic: `${base}/topics/${encodeURIComponent(ring.topic_slug)}` } : {}),
      api: `${base}/api/rings/${encodeURIComponent(ring.slug)}`,
    })),
  });
}
