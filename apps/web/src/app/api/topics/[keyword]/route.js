import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../../../lib/db.js';
import { groupsWithFeeds, topicGroup } from '../../../../lib/topicGroups.js';
import { resolveTopics, topicQueryArg, topicSegment } from '../../../../lib/topicSet.js';

export const dynamic = 'force-dynamic';

/**
 * Every feed filed under one topic, as JSON.
 *
 * The keyword is normalised the same way the page normalises it, so an agent
 * can pass a phrase it read anywhere — "Home Lab", "home-lab" — rather than
 * having to know the slug.
 *
 * `?group=` narrows it to one of the topic's categories, named the same way the
 * pages name them: blogs, podcasts, audio, music, videos, comics, lives, reels.
 * Whether or not one was asked for, the answer lists every group the topic has
 * and how many feeds each holds — so a caller can see what the cuts are without
 * a second request, and a caller that guessed wrong can see what it should have
 * said.
 *
 * Several topics at once — `/api/topics/business,saas,crypto` — answer in the
 * same shape for their union (see lib/topicSet.js): every feed filed under any
 * of them, each once, `total` counting distinct feeds. Three fields are added
 * for a list: `topics` (each known topic with its own count and address),
 * `unknown` (what was asked for and does not exist) and `strength` per feed is
 * the sum across the topics. A list with nothing known is a 404; one longer
 * than ten topics a 400.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ keyword: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { keyword } = await params;

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
  const group = topicGroup(url.searchParams.get('group'));

  const client = db();
  const found = await resolveTopics(client, keyword);

  if (found.error === 'too-many') {
    return new Response(
      JSON.stringify(
        { error: 'too-many-topics', max: found.max, hint: `Combine at most ${found.max} topics.` },
        null,
        2,
      ),
      {
        status: 400,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
        },
      },
    );
  }

  const topic = found.topic;
  if (!topic) {
    const slug = found.unknown.join(',');
    return new Response(JSON.stringify({ error: 'not-found', slug }, null, 2), {
      status: 404,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      },
    });
  }

  const [rows, counts] = await Promise.all([
    q.feedsForTopic(client, topicQueryArg(topic), { limit, offset, kinds: group?.kinds ?? null }),
    q.topicKindCounts(client, topicQueryArg(topic)),
  ]);

  const base = `${siteUrl()}/topics/${topicSegment(topic.slug)}`;

  return new Response(
    JSON.stringify(
      {
        slug: topic.slug,
        keyword: topic.keyword,
        // `total` is what this response is a page of, so it follows the filter.
        // `topicTotal` is the topic entire, which a caller comparing groups
        // needs and would otherwise have to fetch again unfiltered.
        total: group
          ? group.kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0)
          : topic.feedCount,
        topicTotal: topic.feedCount,
        // Only on a combined view, so a single topic's answer is byte for byte
        // what it was.
        ...(topic.multi
          ? {
              topics: (topic.topics ?? []).map((t) => ({
                slug: t.slug,
                keyword: t.keyword,
                feedCount: t.feedCount,
                page: `${siteUrl()}/topics/${encodeURIComponent(t.slug)}`,
                api: `${siteUrl()}/api/topics/${encodeURIComponent(t.slug)}`,
              })),
              unknown: topic.unknown ?? [],
            }
          : {}),
        group: group?.segment ?? null,
        groups: groupsWithFeeds(counts).map(({ group: entry, count }) => ({
          group: entry.segment,
          kinds: entry.kinds,
          feedCount: count,
          page: `${base}/${entry.segment}`,
          feeds: `${base}/${entry.segment}.json`,
        })),
        limit,
        offset,
        page: group ? `${base}/${group.segment}` : base,
        feeds: rows.map((f) => ({
          slug: f.slug,
          title: f.title,
          description: f.description,
          siteUrl: f.site_url,
          // The feed's own address, not ours. Without it a caller that wanted
          // to *subscribe* to what a topic turned up had to fetch every feed's
          // page to find one URL each — so the endpoint answered "here are 126
          // feeds about homelabs" while withholding the only field that makes
          // that answer actionable. /opml?topic= is the bulk form of the same
          // thing.
          feedUrl: f.feed_url,
          kind: f.category,
          itemCount: f.item_count,
          // How this feed came to be on this topic: the publisher's own tag, or
          // a phrase counted across its writing.
          source: f.source,
          strength: Number(f.count ?? 0),
          // Which of the listed topics this feed is filed under.
          ...(topic.multi ? { topics: String(f.topics ?? '').split(',').filter(Boolean) } : {}),
          page: `${siteUrl()}/${f.slug}`,
        })),
      },
      null,
      2,
    ),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
      },
    },
  );
}
