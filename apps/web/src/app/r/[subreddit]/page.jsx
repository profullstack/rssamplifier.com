import { notFound } from 'next/navigation';
import { redditSource } from '@rssamplifier/social';

import { socialFeed, socialMetadata } from '../../../lib/socialPage.js';
import { liveSubredditPosts, threadSlug } from '../../../lib/redditThread.js';
import AddSocialSource from '../../AddSocialSource.jsx';
import FeedPage from '../../[slug]/page.jsx';
import { when } from '../RedditComments.jsx';

export const dynamic = 'force-dynamic';

/**
 * A subreddit at the address people already know how to type.
 *
 * The page is `/{slug}`'s — literally, the same component with the same props —
 * because a subreddit in this directory is a feed like any other and giving it
 * a second, parallel page would be two things to keep in step for no gain. What
 * `/r/` adds is the name: the canonical URL, the feed addresses, and a place
 * for a community that is not in the directory yet to be added from.
 *
 * Rendering the component rather than redirecting to it is deliberate. A
 * redirect would make `/{slug}` the address a reader ends up on and bookmarks,
 * which is the opposite of the intent — see `socialPage.js` for how the two
 * addresses are told apart without either breaking.
 *
 * @param {{ params: Promise<{ subreddit: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { subreddit } = await params;
  const source = redditSource(`r/${subreddit}`);
  if (!source) return { title: 'Not found', robots: { index: false, follow: false } };

  return socialMetadata({
    feed: await socialFeed(source.ref),
    canonical: source.path,
    label: source.title,
    network: 'reddit',
  });
}

/**
 * @param {{ params: Promise<{ subreddit: string }> }} props
 */
export default async function SubredditPage({ params }) {
  const { subreddit } = await params;

  const source = redditSource(`r/${subreddit}`);
  // Not a subreddit name at all. The other miss below — a real name nobody has
  // added — gets an offer to add it; this one gets a 404, because there is
  // nothing at the other end to add and a form here would submit nothing.
  if (!source) notFound();

  const feed = await socialFeed(source.ref);
  if (!feed) {
    return (
      <AddSocialSource
        network="reddit"
        label={source.title}
        input={source.feedUrl}
        canonical={source.path}
      />
    );
  }

  // In the directory but never read: 36,679 subreddits were in that state on
  // 2026-10-06, queued behind one host's crawl budget. Rather than an empty
  // page that says "shortly", show what the archive has right now. The
  // crawler fills the stored copy on its own schedule; this costs one cached
  // request a minute however many people open the page.
  if (!feed.last_success_at && !Number(feed.item_count)) {
    const live = await liveSubredditPosts(source.name).catch(() => null);
    if (live?.length) return <LiveSubreddit source={source} posts={live} />;
  }

  return FeedPage({ params: Promise.resolve({ slug: String(feed.slug) }), base: source.path });
}

/**
 * @param {{ source: { name: string, path: string, title: string }, posts: Array<any> }} props
 */
function LiveSubreddit({ source, posts }) {
  const name = /r\/([A-Za-z0-9_]+)\/comments/.exec(posts[0]?.url ?? '')?.[1] ?? source.name;
  return (
    <>
      <p className="eyebrow">Reddit</p>
      <h1>r/{name}</h1>
      <p className="lede">
        The newest posts, read live from the Reddit archive while this community waits for its first
        crawl. <a href={`https://www.reddit.com/r/${name}/`}>r/{name} on Reddit ↗</a>
      </p>
      {posts.map((p) => (
        <article className="entry" key={p.guid}>
          <h3>
            <a href={`/r/${name}/comments/${p.id}/${threadSlug(p.title)}`}>{p.title}</a>
          </h3>
          {p.summary && <p>{p.summary}</p>}
          <time dateTime={p.publishedAt ?? undefined}>
            {p.publishedAt ? when(p.publishedAt) : ''}
            {p.author ? ` · ${p.author}` : ''}
            {` · ${p.numComments} comment${p.numComments === 1 ? '' : 's'}`}
          </time>
        </article>
      ))}
    </>
  );
}
