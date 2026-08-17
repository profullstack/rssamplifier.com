import { q } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';
import { PLAYLIST_LIMIT } from '../../../lib/topicFeed.js';
import { queueRuntime, rawPlaylistPath, trackFrom } from '../../../lib/player.js';
import PlaylistPlayer from '../../PlaylistPlayer.jsx';

/**
 * A topic's playlist, as a page you can press play on.
 *
 * This is the same query the `.m3u` is built from, at the same limit, rendered
 * for the one client that cannot read an `.m3u`: a browser. Whole topic and one
 * category of it share this for the reason the listings share TopicListing —
 * they differ only in the filter, and two copies would drift.
 *
 * @param {{
 *   topic: { slug: string, keyword: string, feedCount: number },
 *   group?: { segment: string, kinds: string[], heading: string, item: string }|null,
 * }} props
 */
export default async function TopicPlayer({ topic, group = null }) {
  const client = db();
  const slug = encodeURIComponent(topic.slug);

  const rows = await q.mediaForTopic(client, topic.slug, {
    limit: PLAYLIST_LIMIT,
    kinds: group?.kinds ?? null,
  });

  const tracks = rows.map(trackFrom).filter(Boolean);
  const listing = group ? `/topics/${slug}/${group.segment}` : `/topics/${slug}`;
  const hours = queueRuntime(tracks);
  const what = group ? group.item : 'episodes and tracks';

  return (
    <>
      <p className="eyebrow">
        <a href="/topics">Topic</a> · <a href={`/topics/${slug}`}>{topic.keyword}</a>
        {group && (
          <>
            {' · '}
            <a href={listing}>{group.heading}</a>
          </>
        )}
      </p>

      <h1>{group ? `${topic.keyword}: ${group.heading.toLowerCase()}` : topic.keyword}</h1>

      {/* An empty queue is a real answer here rather than a 404. The feeds
          under this topic are indexed and countable — that is why the page was
          linked — but none of their recent posts carries a file, and a reader
          told that plainly can go and read them instead. A 404 would say the
          topic does not exist, which is false. */}
      {tracks.length === 0 ? (
        <p className="lede">
          Nothing on this topic has a file attached to it right now. The writing is all
          still there — <a href={listing}>read the feeds</a> instead.
        </p>
      ) : (
        <>
          <p className="lede">
            {tracks.length === 1
              ? 'One thing to play on this topic.'
              : `The ${tracks.length} most recent ${what} on this topic${hours ? `, about ${hours} of it` : ''}.`}
          </p>

          <PlaylistPlayer
            tracks={tracks}
            label={group ? `${topic.keyword} — ${group.heading}` : topic.keyword}
          />
        </>
      )}

      {/* The same queue as a file, for the reader who came here from a player
          app rather than to one — and the way back to the directory this was
          drawn from. The `.m3u` carries `?dl=1` because the bare address now
          answers a browser with this page, which is the whole point of it. */}
      <p className="format-links">
        <span>This playlist:</span>
        <a href={rawPlaylistPath(`${listing}.m3u`)} title="M3U playlist — for VLC, mpv or a podcast app">
          .m3u
        </a>
        <a href={rawPlaylistPath(`${listing}.pls`)} title="PLS playlist — for VLC, mpv or a podcast app">
          .pls
        </a>
        <a href={listing}>All the feeds behind it</a>
      </p>
    </>
  );
}
