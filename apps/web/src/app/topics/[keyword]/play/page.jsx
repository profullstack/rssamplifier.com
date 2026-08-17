import { notFound } from 'next/navigation';
import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../../lib/db.js';
import { slugFromUrl } from '../../../../lib/topicGroups.js';
import TopicPlayer from '../TopicPlayer.jsx';

export const dynamic = 'force-dynamic';

/**
 * A whole topic, playing: /topics/ai/play.
 *
 * Where `/topics/ai.m3u` sends a browser. A static segment sitting beside the
 * `[group]` one, which Next resolves in that order, and no category is called
 * "play" — see lib/topicGroups.js for the list.
 *
 * @param {{ params: Promise<{ keyword: string }> }} props
 * @returns {Promise<{ topic: { slug: string, keyword: string, feedCount: number } }|null>}
 */
async function resolve({ params }) {
  const { keyword } = await params;
  const topic = await q.topicBySlug(db(), slugFromUrl(keyword));

  return topic ? { topic } : null;
}

/**
 * @param {{ params: Promise<{ keyword: string }> }} props
 */
export async function generateMetadata(props) {
  const found = await resolve(props);
  if (!found) return { title: 'Not found' };

  const { topic } = found;

  return {
    title: `${topic.keyword} — playing`,
    description: `Play the recent podcast episodes and tracks on ${topic.keyword} in your browser.`,
    alternates: { canonical: `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}/play` },
    // Deliberately out of the index. This page is the topic's own listing with
    // a transport on it, and there is one per topic and per category of one —
    // tens of thousands of pages whose text is a heading and a list of episode
    // titles already published on the listing they were drawn from. It exists
    // to be arrived at from that listing, or from an `.m3u` a browser could not
    // open, and neither of those is a search result.
    robots: { index: false, follow: true },
  };
}

/**
 * @param {{ params: Promise<{ keyword: string }> }} props
 */
export default async function TopicPlayerPage(props) {
  const found = await resolve(props);
  if (!found) notFound();

  return <TopicPlayer topic={found.topic} />;
}
