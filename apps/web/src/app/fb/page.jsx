import { siteUrl } from '../../lib/db.js';
import SocialIndex, { pageNumber } from '../SocialIndex.jsx';

export const dynamic = 'force-dynamic';

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export async function generateMetadata({ searchParams }) {
  const page = pageNumber((await searchParams).page);

  return {
    title: page === 1 ? 'Facebook' : `Facebook · page ${page}`,
    description:
      'Facebook Pages whose operators have connected them, as feeds you can subscribe to. Facebook publishes no public feeds, so only connected Pages can appear here.',
    alternates: {
      canonical: page === 1 ? `${siteUrl()}/fb` : `${siteUrl()}/fb?page=${page}`,
    },
  };
}

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function FacebookIndexPage({ searchParams }) {
  return <SocialIndex network="facebook" page={pageNumber((await searchParams).page)} />;
}
