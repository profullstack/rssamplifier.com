import { siteUrl } from '../../lib/db.js';
import SocialIndex, { pageNumber } from '../SocialIndex.jsx';

export const dynamic = 'force-dynamic';

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export async function generateMetadata({ searchParams }) {
  const page = pageNumber((await searchParams).page);

  return {
    title: page === 1 ? 'Reddit' : `Reddit · page ${page}`,
    description:
      'Subreddits and Reddit users in the RSS Amplifier directory, each with a page and a feed at an address that does not change.',
    alternates: {
      canonical: page === 1 ? `${siteUrl()}/r` : `${siteUrl()}/r?page=${page}`,
    },
  };
}

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function RedditIndexPage({ searchParams }) {
  return <SocialIndex network="reddit" page={pageNumber((await searchParams).page)} />;
}
