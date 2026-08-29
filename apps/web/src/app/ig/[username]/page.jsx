import { notFound } from 'next/navigation';
import { instagramSource } from '@rssamplifier/social';

import { socialFeed, socialMetadata } from '../../../lib/socialPage.js';
import AddSocialSource from '../../AddSocialSource.jsx';
import FeedPage from '../../[slug]/page.jsx';

export const dynamic = 'force-dynamic';

/**
 * One Instagram account, at `/ig/nasa`.
 *
 * Same arrangement as `/r/[subreddit]` and `/x/[username]`: the page is
 * `/{slug}`'s, and what this route contributes is the name and the canonical
 * tag. Three platforms sharing one page is the payoff for having built the
 * namespace machinery once.
 *
 * @param {{ params: Promise<{ username: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { username } = await params;
  const source = instagramSource(`ig/${username}`);
  if (!source) return { title: 'Not found', robots: { index: false, follow: false } };

  return socialMetadata({
    feed: await socialFeed(source.ref),
    canonical: source.path,
    label: source.title,
    network: 'instagram',
  });
}

/**
 * @param {{ params: Promise<{ username: string }> }} props
 */
export default async function InstagramAccountPage({ params }) {
  const { username } = await params;

  const source = instagramSource(`ig/${username}`);
  if (!source) notFound();

  const feed = await socialFeed(source.ref);
  if (!feed) {
    return (
      <AddSocialSource
        network="instagram"
        label={source.title}
        input={source.url}
        canonical={source.path}
      />
    );
  }

  return FeedPage({ params: Promise.resolve({ slug: String(feed.slug) }) });
}
