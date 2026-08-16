import { siteUrl } from '../../lib/db.js';
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
    },
  };
}

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function ReelsPage({ searchParams }) {
  return <CategoryIndex kind="reel" page={pageNumber((await searchParams).page)} />;
}
