import { db } from '../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * Send the visitor to a random blog — the toolbar's ✦ button.
 *
 * Picks by random offset rather than `order by random()`, which would sort the
 * whole table on every click.
 */
export async function GET() {
  const sb = db();

  const { count } = await sb
    .from('feeds')
    .select('id', { count: 'exact', head: true })
    .neq('status', 'dead');

  if (!count) return new Response(null, { status: 302, headers: { location: '/' } });

  const offset = Math.floor(Math.random() * count);
  const { data } = await sb
    .from('feeds')
    .select('slug')
    .neq('status', 'dead')
    .order('created_at', { ascending: false })
    .range(offset, offset)
    .limit(1);

  const slug = data?.[0]?.slug;
  return new Response(null, { status: 302, headers: { location: slug ? `/${slug}` : '/' } });
}
