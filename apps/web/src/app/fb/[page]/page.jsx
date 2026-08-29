import { notFound } from 'next/navigation';
import { facebookSource } from '@rssamplifier/social';

import { socialFeed, socialMetadata } from '../../../lib/socialPage.js';
import AddSocialSource from '../../AddSocialSource.jsx';
import FeedPage from '../../[slug]/page.jsx';

export const dynamic = 'force-dynamic';

/**
 * One Facebook Page, at `/fb/SomePage`.
 *
 * The one namespace of the four where "not here yet" usually means "not
 * possible" rather than "nobody has got round to it". Facebook has no public
 * feed, no unauthenticated HTML and no provider — the only way in is a Page
 * Access Token from whoever administers the Page — so the empty state explains
 * that rather than offering a button that would quietly do nothing.
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
