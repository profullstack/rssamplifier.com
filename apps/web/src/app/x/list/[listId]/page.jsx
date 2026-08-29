import { notFound } from 'next/navigation';
import { xSource } from '@rssamplifier/social';

import { socialFeed, socialMetadata } from '../../../../lib/socialPage.js';
import AddSocialSource from '../../../AddSocialSource.jsx';
import FeedPage from '../../../[slug]/page.jsx';

export const dynamic = 'force-dynamic';

/**
 * An X list, at `/x/list/123456789`.
 *
 * @param {{ params: Promise<{ listId: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { listId } = await params;
  const source = xSource(`https://x.com/i/lists/${listId}`);
  if (!source) return { title: 'Not found', robots: { index: false, follow: false } };

  return socialMetadata({
    feed: await socialFeed(source.ref),
    canonical: source.path,
    label: source.title,
    network: 'x',
  });
}

/**
 * @param {{ params: Promise<{ listId: string }> }} props
 */
export default async function XListPage({ params }) {
  const { listId } = await params;

  const source = xSource(`https://x.com/i/lists/${listId}`);
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
