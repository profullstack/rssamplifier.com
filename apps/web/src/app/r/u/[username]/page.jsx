import { notFound } from 'next/navigation';
import { redditSource } from '@rssamplifier/social';

import { socialFeed, socialMetadata } from '../../../../lib/socialPage.js';
import AddSocialSource from '../../../AddSocialSource.jsx';
import FeedPage from '../../../[slug]/page.jsx';

export const dynamic = 'force-dynamic';

/**
 * One Reddit user, at `/r/u/spez`.
 *
 * Under `/r/` rather than at `/u/`, so one prefix holds all of Reddit. It also
 * keeps `/u/` free, which matters more than it sounds: `/{slug}` is the
 * catch-all at the root of this site, and every prefix claimed is a slug taken
 * away from the directory.
 *
 * @param {{ params: Promise<{ username: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { username } = await params;
  const source = redditSource(`u/${username}`);
  if (!source) return { title: 'Not found', robots: { index: false, follow: false } };

  return socialMetadata({
    feed: await socialFeed(source.ref),
    canonical: source.path,
    label: source.title,
    network: 'reddit',
  });
}

/**
 * @param {{ params: Promise<{ username: string }> }} props
 */
export default async function RedditUserPage({ params }) {
  const { username } = await params;

  const source = redditSource(`u/${username}`);
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
