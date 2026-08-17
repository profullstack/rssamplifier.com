import { notFound } from 'next/navigation';
import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import { slugFromUrl } from '../../../lib/topicGroups.js';
import { pageNumber } from '../../CategoryIndex.jsx';
import TopicListing from './TopicListing.jsx';

export const dynamic = 'force-dynamic';

/**
 * @param {{ params: Promise<{ keyword: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { keyword } = await params;
  const topic = await q.topicBySlug(db(), slugFromUrl(keyword));
  if (!topic) return { title: 'Not found' };

  const page = `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}`;

  return {
    title: topic.keyword,
    description: `${topic.feedCount} blogs and podcasts in the RSS Amplifier directory write about ${topic.keyword}.`,
    alternates: {
      canonical: page,
      // Autodiscovery, which is how a browser extension or a reader offers to
      // subscribe from the page itself rather than making somebody find the
      // link. Only the two XML formats go here: `types` renders
      // `<link rel="alternate">`, and a reader that follows an unexpected type
      // reports a broken feed.
      types: {
        'application/rss+xml': [{ url: `${page}.rss`, title: `${topic.keyword} — RSS` }],
        'application/atom+xml': [{ url: `${page}.atom`, title: `${topic.keyword} — Atom` }],
        'application/feed+json': [{ url: `${page}.json`, title: `${topic.keyword} — JSON Feed` }],
      },
    },
  };
}

/**
 * One topic: every feed in the directory that writes about it.
 *
 * @param {{ params: Promise<{ keyword: string }>, searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function TopicPage({ params, searchParams }) {
  const { keyword } = await params;
  const slug = slugFromUrl(keyword);
  const client = db();

  const [topic, counts] = await Promise.all([
    q.topicBySlug(client, slug),
    q.topicKindCounts(client, slug),
  ]);
  if (!topic) notFound();

  return (
    <TopicListing topic={topic} counts={counts} page={pageNumber((await searchParams).page)} />
  );
}
