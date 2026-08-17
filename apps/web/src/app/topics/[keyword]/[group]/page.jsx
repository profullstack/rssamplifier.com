import { notFound } from 'next/navigation';
import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../../lib/db.js';
import { slugFromUrl, topicGroup } from '../../../../lib/topicGroups.js';
import { pageNumber } from '../../../CategoryIndex.jsx';
import TopicListing from '../TopicListing.jsx';

export const dynamic = 'force-dynamic';

/**
 * One category of one topic: /topics/physics/podcasts.
 *
 * Everything here comes from the topic page's own queries with a category
 * filter on them, and renders through the same component — see TopicListing.
 * What this file owns is reading the two segments and deciding when there is
 * nothing to show.
 *
 * @param {{ params: Promise<{ keyword: string, group: string }> }} props
 * @returns {Promise<{
 *   topic: { slug: string, keyword: string, feedCount: number },
 *   counts: Record<string, number>,
 *   group: NonNullable<ReturnType<typeof topicGroup>>,
 *   total: number,
 * }|null>}
 */
async function resolve({ params }) {
  const { keyword, group: segment } = await params;
  const group = topicGroup(segment);
  if (!group) return null;

  const client = db();
  const slug = slugFromUrl(keyword);

  const [topic, counts] = await Promise.all([
    q.topicBySlug(client, slug),
    q.topicKindCounts(client, slug),
  ]);
  if (!topic) return null;

  const total = group.kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
  // An empty sub-group is a 404 rather than a page saying "no comics cover
  // this". Every topic has eight of these addresses and most topics have feeds
  // in two or three of them, so rendering the empty ones would put tens of
  // thousands of near-identical thin pages into the index for no reader's
  // benefit.
  if (total === 0) return null;

  return { topic, counts, group, total };
}

/**
 * @param {{ params: Promise<{ keyword: string, group: string }> }} props
 */
export async function generateMetadata(props) {
  const found = await resolve(props);
  if (!found) return { title: 'Not found' };

  const { topic, group, total } = found;
  const page = `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}/${group.segment}`;
  const heading = `${topic.keyword}: ${group.heading.toLowerCase()}`;

  return {
    title: heading,
    description: `${total} ${group.noun} in the RSS Amplifier directory cover ${topic.keyword}.`,
    alternates: {
      canonical: page,
      types: {
        'application/rss+xml': [{ url: `${page}.rss`, title: `${heading} — RSS` }],
        'application/atom+xml': [{ url: `${page}.atom`, title: `${heading} — Atom` }],
        'application/feed+json': [{ url: `${page}.json`, title: `${heading} — JSON Feed` }],
      },
    },
  };
}

/**
 * @param {{
 *   params: Promise<{ keyword: string, group: string }>,
 *   searchParams: Promise<Record<string, string|string[]|undefined>>,
 * }} props
 */
export default async function TopicGroupPage(props) {
  const found = await resolve(props);
  if (!found) notFound();

  return (
    <TopicListing
      topic={found.topic}
      counts={found.counts}
      group={found.group}
      page={pageNumber((await props.searchParams).page)}
    />
  );
}
