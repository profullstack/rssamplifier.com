import { notFound } from 'next/navigation';
import { instagramSource } from '@rssamplifier/social';

import { socialFeed, socialMetadata } from '../../../../lib/socialPage.js';
import AddSocialSource from '../../../AddSocialSource.jsx';
import FeedPage from '../../../[slug]/page.jsx';

export const dynamic = 'force-dynamic';

/**
 * One Instagram hashtag, at `/ig/tag/coffee`.
 *
 * @param {{ params: Promise<{ tag: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { tag } = await params;
  const source = instagramSource(`https://www.instagram.com/explore/tags/${tag}/`);
  if (!source) return { title: 'Not found', robots: { index: false, follow: false } };

  return socialMetadata({
    feed: await socialFeed(source.ref),
    canonical: source.path,
    label: source.title,
    network: 'instagram',
  });
}

/**
 * @param {{ params: Promise<{ tag: string }> }} props
 */
export default async function InstagramTagPage({ params }) {
  const { tag } = await params;

  const source = instagramSource(`https://www.instagram.com/explore/tags/${tag}/`);
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
