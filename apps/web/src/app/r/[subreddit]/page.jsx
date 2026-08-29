import { notFound } from 'next/navigation';
import { redditSource } from '@rssamplifier/social';

import { socialFeed, socialMetadata } from '../../../lib/socialPage.js';
import AddSocialSource from '../../AddSocialSource.jsx';
import FeedPage from '../../[slug]/page.jsx';

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

  return FeedPage({ params: Promise.resolve({ slug: String(feed.slug) }) });
}
