import { siteUrl } from '../../lib/db.js';
import { feedAlternates } from '../../lib/subscribe.js';
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
export default async function BlogsPage({ searchParams }) {
  return <CategoryIndex kind="blog" page={pageNumber((await searchParams).page)} />;
}
