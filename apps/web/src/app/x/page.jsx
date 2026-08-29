import { siteUrl } from '../../lib/db.js';
import SocialIndex, { pageNumber } from '../SocialIndex.jsx';

export const dynamic = 'force-dynamic';

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export async function generateMetadata({ searchParams }) {
  const page = pageNumber((await searchParams).page);

  return {
    title: page === 1 ? 'X' : `X · page ${page}`,
    description:
      'X accounts, searches and lists as feeds you can subscribe to — collected by RSS Amplifier and served from here, never from X.',
    alternates: {
      canonical: page === 1 ? `${siteUrl()}/x` : `${siteUrl()}/x?page=${page}`,
    },
  };
}

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function XIndexPage({ searchParams }) {
  return <SocialIndex network="x" page={pageNumber((await searchParams).page)} />;
}
