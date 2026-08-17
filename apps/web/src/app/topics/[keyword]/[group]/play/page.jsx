import { notFound } from 'next/navigation';
import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../../../lib/db.js';
import { slugFromUrl, topicGroup } from '../../../../../lib/topicGroups.js';
import TopicPlayer from '../../TopicPlayer.jsx';

export const dynamic = 'force-dynamic';

/**
 * One category of one topic, playing: /topics/ai/podcasts/play.
 *
 * Where `/topics/ai/podcasts.m3u` sends a browser, and the address the reader
 * most often wants — a topic's podcasts are a playlist in a way the whole topic
 * is not.
 *
 * Only the groups that publish playlists have one. The rest are refused for the
 * reason the `.m3u` link is not offered on them: the query behind a playlist
 * selects rows with an enclosure, and a blog has none, so a player page there
 * would be an empty transport over an empty list.
 *
 * @param {{ params: Promise<{ keyword: string, group: string }> }} props
 * @returns {Promise<{
 *   topic: { slug: string, keyword: string, feedCount: number },
 *   group: NonNullable<ReturnType<typeof topicGroup>>,
 * }|null>}
 */
async function resolve({ params }) {
  const { keyword, group: segment } = await params;
  const group = topicGroup(segment);
  if (!group?.playlists) return null;

  const client = db();
  const slug = slugFromUrl(keyword);

  const [topic, counts] = await Promise.all([
    q.topicBySlug(client, slug),
    q.topicKindCounts(client, slug),
  ]);
  if (!topic) return null;

  // An empty sub-group is a 404 here for the same reason it is one on the
  // listing next door: the address exists for every topic, and most topics have
  // nothing under most of them.
  const total = group.kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
  if (total === 0) return null;

  return { topic, group };
}

/**
 * @param {{ params: Promise<{ keyword: string, group: string }> }} props
 */
export async function generateMetadata(props) {
  const found = await resolve(props);
  if (!found) return { title: 'Not found' };

  const { topic, group } = found;
  const path = `/topics/${encodeURIComponent(topic.slug)}/${group.segment}/play`;

  return {
    title: `${topic.keyword}: ${group.heading.toLowerCase()} — playing`,
    description: `Play the recent ${group.item} on ${topic.keyword} in your browser.`,
    alternates: { canonical: `${siteUrl()}${path}` },
    // Out of the index, for the reason set out on the whole-topic player.
    robots: { index: false, follow: true },
  };
}

/**
 * @param {{ params: Promise<{ keyword: string, group: string }> }} props
 */
export default async function TopicGroupPlayerPage(props) {
  const found = await resolve(props);
  if (!found) notFound();

  return <TopicPlayer topic={found.topic} group={found.group} />;
}
