import { webrings } from '@rssamplifier/db';
import { Plus, Tag, Trophy } from 'lucide-react';

import { db, siteUrl } from '../../lib/db.js';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

export function generateMetadata() {
  return {
    title: 'Webrings',
    description:
      'Webrings hosted by the directory: one per well-covered topic, each an ordered ring of member sites with next, previous and random hops.',
    alternates: { canonical: `${siteUrl()}/ring` },
  };
}

/**
 * The rings this site hosts.
 *
 * A webring is the oldest way the small web had of sending readers to each
 * other, and it needs nothing from the sites in it but one link. These are
 * OpenWebring rings (logicsrc.com/openwebring): one per topic the directory
 * covers well, seeded from the feeds filed under it, verified by a slow
 * crawl of each member's front page. Membership is a fact about the site,
 * not a form: a feed in the directory under the topic is listed, and it is
 * active from the moment its site links back.
 */
export default async function RingsPage() {
  const rings = await webrings.listRings(db());

  return (
    <>
      <h1>Webrings</h1>
      <p className="lede">
        Every topic in the directory is a ring, and anyone can make one of their own. A ring is an
        ordered, circular list of member sites with three hops: next, previous and random. A member
        site owes the ring one plain link and nothing else, and is free to say who makes it: humans,
        AI, or both.
      </p>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <a href="/ring/new">
            <Plus /> Make a ring
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href="/topics" title="Any topic page has a Webring button; the ring is at /ring/<topic>">
            <Tag /> Every topic is a ring
          </a>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <a href="/ring/leaders">
            <Trophy /> Leaders
          </a>
        </Button>
      </div>

      {rings.length === 0 ? (
        <p className="empty">
          No rings yet. They are seeded by the crawler from the most covered topics and appear here
          once the first pass has run.
        </p>
      ) : (
        <ul className="feed-list">
          {rings.map((ring) => (
            <li key={ring.slug} className="feed-row">
              <a href={`/ring/${encodeURIComponent(ring.slug)}`}>{ring.title}</a>{' '}
              <span className="pill">
                {ring.active_count} active of {ring.member_count}
              </span>
              {ring.description && <span className="meta"> {ring.description}</span>}
            </li>
          ))}
        </ul>
      )}

      <p className="meta">
        Machine-readable: <a href="/.well-known/openwebring.json">openwebring.json</a> ·{' '}
        <a href="/api/rings">JSON API</a> · the spec at{' '}
        <a href="https://logicsrc.com/openwebring">logicsrc.com/openwebring</a>
      </p>
    </>
  );
}
