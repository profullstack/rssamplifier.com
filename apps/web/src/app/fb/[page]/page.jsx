import { notFound } from 'next/navigation';
import { facebookSource } from '@rssamplifier/social';

import { socialFeed, socialMetadata } from '../../../lib/socialPage.js';
import AddSocialSource from '../../AddSocialSource.jsx';
import FeedPage from '../../[slug]/page.jsx';

export const dynamic = 'force-dynamic';

/**
 * One Facebook Page, at `/fb/SomePage`.
 *
 * Read with a session against mbasic, like X and Instagram are — so this takes
 * open submissions like they do. It is the least reliable of the four by some
 * distance; see @rssamplifier/social's facebook/scrape.js for why, and for the
 * one place to look when it stops working.
 *
 * @param {{ params: Promise<{ page: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { page } = await params;
  const source = facebookSource(`fb/${page}`);
  if (!source) return { title: 'Not found', robots: { index: false, follow: false } };

  return socialMetadata({
    feed: await socialFeed(source.ref),
    canonical: source.path,
    label: source.title,
    network: 'facebook',
  });
}

/**
 * @param {{ params: Promise<{ page: string }> }} props
 */
export default async function FacebookPagePage({ params }) {
  const { page } = await params;

  const source = facebookSource(`fb/${page}`);
  if (!source) notFound();

  const feed = await socialFeed(source.ref);
  if (!feed) {
    return (
      <AddSocialSource
        network="facebook"
        label={source.title}
        input={source.url}
        canonical={source.path}
      />
    );
  }

  return FeedPage({ params: Promise.resolve({ slug: String(feed.slug) }) });
}
