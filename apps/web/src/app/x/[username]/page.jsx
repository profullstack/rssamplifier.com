import { notFound } from 'next/navigation';
import { xSource } from '@rssamplifier/social';

import { socialFeed, socialMetadata } from '../../../lib/socialPage.js';
import AddSocialSource from '../../AddSocialSource.jsx';
import FeedPage from '../../[slug]/page.jsx';

export const dynamic = 'force-dynamic';

/**
 * One X account, at `/x/OpenAI`.
 *
 * Same arrangement as `/r/[subreddit]`: the page is `/{slug}`'s, and what this
 * route contributes is the name and the canonical tag. See that file for why
 * it renders rather than redirects.
 *
 * @param {{ params: Promise<{ username: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { username } = await params;
  const source = xSource(username);
  if (!source) return { title: 'Not found', robots: { index: false, follow: false } };

  return socialMetadata({
    feed: await socialFeed(source.ref),
    canonical: source.path,
    label: source.title,
    network: 'x',
  });
}

/**
 * @param {{ params: Promise<{ username: string }> }} props
 */
export default async function XAccountPage({ params }) {
  const { username } = await params;

  const source = xSource(username);
  if (!source) notFound();

  const feed = await socialFeed(source.ref);
  if (!feed) {
    return (
      <AddSocialSource
        network="x"
        label={source.title}
        input={source.url}
        canonical={source.path}
      />
    );
  }

  return FeedPage({ params: Promise.resolve({ slug: String(feed.slug) }) });
}
