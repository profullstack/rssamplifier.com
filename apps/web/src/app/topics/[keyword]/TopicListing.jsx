import { accounts, q } from '@rssamplifier/db';
import { SYNDICATION_FORMATS } from '@rssamplifier/feed';

import { db, siteUrl } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';
import { AD_TEXT, adPlan } from '../../../lib/ads.js';
import { IN_BROWSER_KINDS, PLAYABLE_KINDS, groupsWithFeeds } from '../../../lib/topicGroups.js';
import { shareText } from '../../../lib/share.js';
import Ad from '../../Ad.jsx';
import AdBanner from '../../AdBanner.jsx';
import FollowButton from '../../FollowButton.jsx';
import Share from '../../Share.jsx';

/** Feeds per page. Matches the category pages. */
export const PAGE_SIZE = 60;

/**
 * The formats offered on a listing, in the order a visitor is likely to want one.
 *
 * The three feed formats first, then the two playlists — which are only offered
 * where the group's entries are files a player can queue. `.xml` is a supported
 * alias for `.rss` and is deliberately absent: it is the same document under a
 * second name, and offering both invites the question of how they differ.
 *
 * @param {{ playlists: boolean }|null} group
 * @returns {string[]}
 */
function formatsFor(group) {
  // The whole topic keeps all five: it contains whatever it contains, and a
  // topic with a single podcast in it still has a playlist worth offering.
  if (!group) return ['rss', 'atom', 'json', 'm3u', 'pls'];
  return group.playlists ? ['rss', 'atom', 'json', 'm3u', 'pls'] : ['rss', 'atom', 'json'];
}

/**
 * What each extension is, for the link's title attribute.
 *
 * @param {string} ext
 * @param {string} what the noun for what this listing holds
 * @returns {string}
 */
function formatTitle(ext, what) {
  const names = {
    rss: 'RSS 2.0',
    atom: 'Atom 1.0',
    json: 'JSON Feed 1.1',
    m3u: 'M3U playlist',
    pls: 'PLS playlist',
  };

  return ext === 'm3u' || ext === 'pls'
    ? `${names[ext]} — the playable media from ${what}`
    : `${names[ext]} — recent posts from ${what}`;
}

/**
 * One topic, or one category of it, as a page of feeds.
 *
 * The whole topic and a sub-group of it are the same page over a different
 * filter — the same relationship /blogs has to the directory index — so they
 * share this and differ only in what is passed in. Two copies would drift the
 * moment one of them grew a feature, and the sub-groups exist precisely because
 * there are now eight of them per topic.
 *
 * @param {{
 *   topic: { slug: string, keyword: string, feedCount: number },
 *   counts: Record<string, number>,
 *   group?: import('../../../lib/topicGroups.js').TOPIC_GROUPS[number]|null,
 *   page?: number,
 * }} props
 */
export default async function TopicListing({ topic, counts, group = null, page = 1 }) {
  const client = db();
  const slug = encodeURIComponent(topic.slug);

  const base = group ? `/topics/${slug}/${group.segment}` : `/topics/${slug}`;
  const total = group
    ? group.kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0)
    : topic.feedCount;

  const [rows, user] = await Promise.all([
    q.feedsForTopic(client, topic.slug, {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      kinds: group?.kinds ?? null,
    }),
    currentUser(),
  ]);

  // Only asked once we know there is someone to ask about. A signed-out visitor
  // still gets the button — the endpoint sends them to sign in and back here —
  // so this decides what it says rather than whether it appears.
  const following = user
    ? await accounts.isFollowingTopic(client, String(user.id), topic.slug, group?.segment ?? '')
    : false;

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const ads = adPlan(rows.length, { first: 11, every: 24, max: 2 });
  const groups = groupsWithFeeds(counts);
  const what = group ? `the ${group.noun} on this topic` : 'this topic';

  // Whether the playlist files are worth offering. A sub-group says so
  // outright; the whole topic is asked the same question of its counts, because
  // a topic covered entirely by blogs has an `.m3u` that is legitimately empty
  // and a link to it would be a download that turns out to hold nothing.
  const playlists = group
    ? group.playlists
    : [...PLAYABLE_KINDS].some((kind) => (counts[kind] ?? 0) > 0);

  // Whether there is anything here to press play on, which is the wider
  // question — the browser can play a topic's videos, and no playlist file can.
  // See IN_BROWSER_KINDS.
  const player = group
    ? group.player
    : [...IN_BROWSER_KINDS].some((kind) => (counts[kind] ?? 0) > 0);

  // Named once and used three times over: as the heading, as the title a share
  // sheet shows, and inside the blurb that gets pasted.
  const heading = group ? `${topic.keyword}: ${group.heading.toLowerCase()}` : topic.keyword;
  const lede =
    total === 1
      ? `One ${group ? group.one : 'feed'} in the directory covers this.`
      : `${total} ${group ? group.noun : 'feeds'} in the directory cover this.`;
  const pageUrl = `${siteUrl()}${base}`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: group ? `${topic.keyword} — ${group.heading}` : topic.keyword,
    about: { '@type': 'Thing', name: topic.keyword },
    url: pageUrl,
    hasPart: rows.slice(0, 20).map((f) => ({
      '@type': f.category === 'podcast' ? 'PodcastSeries' : 'Blog',
      name: f.title,
      url: `${siteUrl()}/${f.slug}`,
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <p className="eyebrow">
        {group ? (
          <>
            <a href="/topics">Topic</a> · <a href={`/topics/${slug}`}>{topic.keyword}</a>
          </>
        ) : (
          <a href="/topics">Topic</a>
        )}
      </p>
      <h1>{heading}</h1>
      <p className="lede">{lede}</p>

      {/* The topic's other categories. Shown on the sub-group pages too, so
          moving between them never costs a trip back through the topic — which
          is the whole reason for cutting the topic up. Only the groups that
          have something in them are listed. */}
      {groups.length > 1 && (
        <nav className="topic-groups" aria-label="This topic by category">
          <a
            href={`/topics/${slug}`}
            aria-current={group ? undefined : 'page'}
            className={group ? undefined : 'is-current'}
          >
            All <span>{topic.feedCount}</span>
          </a>
          {groups.map(({ group: entry, count }) => (
            <a
              key={entry.segment}
              href={`/topics/${slug}/${entry.segment}`}
              aria-current={entry.segment === group?.segment ? 'page' : undefined}
              className={entry.segment === group?.segment ? 'is-current' : undefined}
            >
              {entry.heading} <span>{count}</span>
            </a>
          ))}
        </nav>
      )}

      {/* This page, as something to subscribe to. Kept to the bare extensions
          and set quietly under the heading: a reader who wants a feed knows
          what ".rss" means and is scanning for exactly that, and everyone else
          should be able to read past it without it competing with the list. */}
      <p className="format-links">
        {/* Before the extensions, because it is the one on this row that most
            readers want and the only one that works where they are standing. A
            browser cannot play an `.m3u`, so the playlist links below are for
            handing to a player app; this is the same queue, here. */}
        {player && (
          <a className="play-link" href={`${base}/play`}>
            ▶ {group?.watch ? 'Watch' : 'Play'}
          </a>
        )}
        <span>Subscribe:</span>
        {formatsFor(group).map((ext) => (
          <a
            key={ext}
            href={`${base}.${ext}`}
            title={formatTitle(ext, what)}
            // The advisory type a reader uses to decide it can handle the link
            // before following it. Without the charset: the attribute takes a
            // MIME type, and the parameter belongs on the response header.
            type={SYNDICATION_FORMATS.get(ext)?.type.split(';')[0]}
          >
            {`.${ext}`}
          </a>
        ))}
      </p>

      {/* Sat with the subscribe links rather than up beside the heading: both
          are ways of taking this page somewhere else, and one row of quiet
          controls is better than two. */}
      <div className="detail-actions topic">
        {/* Following a subject, not a publication. The extensions above hand this
            page to a reader app; this hands it to /following, which is the same
            river merged with everything else this account follows — and the only
            one of the two that survives adding a second topic. Still a plain
            form underneath, so it works with JavaScript off; with JavaScript it
            flips in place rather than reloading a page of sixty feeds to change
            two words on one button. */}
        <FollowButton
          endpoint="/api/follows/topics"
          slug={topic.slug}
          segment={group?.segment ?? ''}
          following={following}
          signedIn={Boolean(user)}
          next={base}
          label="Follow this topic"
        />

        <Share
          url={pageUrl}
          title={heading}
          text={shareText({ title: heading, summary: lede, url: pageUrl })}
          textLabel="Copy topic"
        />
      </div>

      <Ad format={AD_TEXT} />

      <div className="feed-list">
        {rows.flatMap((f, i) => {
          const row = (
            <a className="feed-row" key={String(f.slug)} href={`/${f.slug}`}>
              <h3>{f.title}</h3>
              {f.description && <p>{f.description}</p>}
              <div className="feed-meta">
                <span>{f.category === 'podcast' ? 'Podcast' : 'Blog'}</span>
                {/* Where this feed's place on the page came from. A publisher's
                    own tag is a different claim from a word we counted, and the
                    reader deserves to know which they are looking at. */}
                <span>
                  {f.source === 'category' ? 'tagged by the author' : `${f.count} mentions`}
                </span>
                <span>
                  {f.item_count} {f.category === 'podcast' ? 'episodes' : 'posts'}
                </span>
              </div>
            </a>
          );

          const format = ads.get(i);
          return format ? [row, <Ad key={`ad-${i}`} format={format} inFeed />] : [row];
        })}
      </div>

      {lastPage > 1 && (
        <nav className="pager" aria-label="Topic pages">
          {page > 1 ? (
            <a href={page === 2 ? base : `${base}?page=${page - 1}`} rel="prev">
              ← Previous
            </a>
          ) : (
            <span className="disabled">← Previous</span>
          )}
          <span className="pill">
            Page {page} of {lastPage}
          </span>
          {page < lastPage ? (
            <a href={`${base}?page=${page + 1}`} rel="next">
              Next →
            </a>
          ) : (
            <span className="disabled">Next →</span>
          )}
        </nav>
      )}

      {/* The feed links above are the posts; this one is the directory listing
          — who covers the topic, rather than what they published. Two different
          documents, so both are offered and both say which they are. */}
      <p className="hint">
        Machine-readable:{' '}
        <a href={`/api/topics/${slug}${group ? `?group=${group.segment}` : ''}`}>
          this list of feeds, as JSON
        </a>{' '}
        · <a href={`${base}.json`}>their recent posts, as JSON Feed</a> ·{' '}
        <a href="/topics">all topics</a>
      </p>

      <AdBanner />
    </>
  );
}
