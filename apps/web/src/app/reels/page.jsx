import { siteUrl } from '../../lib/db.js';
import { feedAlternates } from '../../lib/subscribe.js';
import CategoryIndex, { CATEGORIES, pageNumber } from '../CategoryIndex.jsx';

export const dynamic = 'force-dynamic';

const CATEGORY = CATEGORIES.reel;

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export async function generateMetadata({ searchParams }) {
  const page = pageNumber((await searchParams).page);

  return {
    title: page === 1 ? CATEGORY.title : `${CATEGORY.title} · page ${page}`,
    description: CATEGORY.lede,
    alternates: {
      canonical:
        page === 1 ? `${siteUrl()}${CATEGORY.path}` : `${siteUrl()}${CATEGORY.path}?page=${page}`,
      // The category's own feed: what has just been added to it. Announced on
      // every page of the listing rather than only the first, because it is the
      // same feed either way and a reader deep in the directory is exactly the
      // one who wants telling when more arrives.
      types: feedAlternates(`${siteUrl()}${CATEGORY.path}`, CATEGORY.heading),
    },
  };
}

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function ReelsPage({ searchParams }) {
  return <CategoryIndex kind="reel" page={pageNumber((await searchParams).page)} />;
}
