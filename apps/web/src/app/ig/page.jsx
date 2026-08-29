import { siteUrl } from '../../lib/db.js';
import SocialIndex, { pageNumber } from '../SocialIndex.jsx';

export const dynamic = 'force-dynamic';

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export async function generateMetadata({ searchParams }) {
  const page = pageNumber((await searchParams).page);

  return {
    title: page === 1 ? 'Instagram' : `Instagram · page ${page}`,
    description:
      'Instagram accounts and hashtags as feeds you can subscribe to — collected by RSS Amplifier and served from here, never from Instagram.',
    alternates: {
      canonical: page === 1 ? `${siteUrl()}/ig` : `${siteUrl()}/ig?page=${page}`,
    },
  };
}

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function InstagramIndexPage({ searchParams }) {
  return <SocialIndex network="instagram" page={pageNumber((await searchParams).page)} />;
}
