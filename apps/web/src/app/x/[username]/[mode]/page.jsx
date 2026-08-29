import { notFound } from 'next/navigation';
import { xSource } from '@rssamplifier/social';

import { socialFeed, socialMetadata } from '../../../../lib/socialPage.js';
import AddSocialSource from '../../../AddSocialSource.jsx';
import FeedPage from '../../../[slug]/page.jsx';

export const dynamic = 'force-dynamic';

/** The tabs that are feeds of their own: `/x/OpenAI/replies`, `/x/OpenAI/media`. */
const MODES = { replies: 'with_replies', media: 'media' };

/**
 * @param {{ username: string, mode: string }} params
 */
function sourceFor({ username, mode }) {
  const tab = MODES[mode];
  return tab ? xSource(`https://x.com/${username}/${tab}`) : null;
}

/**
 * @param {{ params: Promise<{ username: string, mode: string }> }} props
 */
export async function generateMetadata({ params }) {
  const source = sourceFor(await params);
  if (!source) return { title: 'Not found', robots: { index: false, follow: false } };

  return socialMetadata({
    feed: await socialFeed(source.ref),
    canonical: source.path,
    label: source.title,
    network: 'x',
  });
}

/**
 * @param {{ params: Promise<{ username: string, mode: string }> }} props
 */
export default async function XModePage({ params }) {
  const source = sourceFor(await params);
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
