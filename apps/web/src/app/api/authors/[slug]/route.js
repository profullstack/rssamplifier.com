import { authors } from '@rssamplifier/db';

import { db, siteUrl } from '../../../../lib/db.js';
import { json, shape } from '../route.js';

export const dynamic = 'force-dynamic';

/**
 * One author, with everything they publish.
 *
 * The feed list is what this adds over the index: it is the answer to "is this
 * the same Kim Alvarez", which a name and a Mastodon handle on their own
 * cannot settle.
 *
 * @param {Request} _req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(_req, ctx) {
  const { slug } = await ctx.params;
  const person = await authors.authorBySlug(db(), slug);

  if (!person) return json({ error: 'not-found', slug }, 404);

  return json({
    ...shape(person),
    feeds: (person.feeds ?? []).map((feed) => ({
      slug: String(feed.slug),
      title: String(feed.title),
      kind: feed.kind ?? null,
      site: feed.site_url ?? null,
      itemCount: Number(feed.item_count ?? 0),
      // Whether they publish it or merely write in it, which is the difference
      // between a person's blog and a magazine they contribute to.
      role: String(feed.role ?? 'author'),
      page: `${siteUrl()}/${encodeURIComponent(String(feed.slug))}`,
      api: `${siteUrl()}/api/feeds/${encodeURIComponent(String(feed.slug))}`,
    })),
  });
}
