import { siteUrl } from '../../lib/db.js';
import CategoryIndex, { CATEGORIES, pageNumber } from '../CategoryIndex.jsx';

export const dynamic = 'force-dynamic';

const CATEGORY = CATEGORIES.blog;

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export async function generateMetadata({ searchParams }) {
  const page = pageNumber((await searchParams).page);

  return {
    title: page === 1 ? CATEGORY.title : `${CATEGORY.title} · page ${page}`,
    description: CATEGORY.lede,
    // Every page canonicalises to itself, not to page 1: they hold different
    // blogs, so collapsing them would ask crawlers to drop the tail of the
    // directory.
    alternates: {
      canonical:
        page === 1 ? `${siteUrl()}${CATEGORY.path}` : `${siteUrl()}${CATEGORY.path}?page=${page}`,
    },
  };
}

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function BlogsPage({ searchParams }) {
  return <CategoryIndex kind="blog" page={pageNumber((await searchParams).page)} />;
}
