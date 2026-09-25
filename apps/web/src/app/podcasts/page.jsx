import { siteUrl } from '../../lib/db.js';
import CategoryIndex, { CATEGORIES, listHref, pageNumber, viewName } from '../CategoryIndex.jsx';

export const dynamic = 'force-dynamic';

const CATEGORY = CATEGORIES.podcast;

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export async function generateMetadata({ searchParams }) {
  const params = await searchParams;
  const page = pageNumber(params.page);
  const view = viewName(params.view, CATEGORY);

  const what = view === 'shows' ? 'every show' : 'the newest episodes';
  const title = view === 'shows' ? 'Podcasts · every show' : CATEGORY.title;

  return {
    title: page === 1 ? title : `${title} · page ${page}`,
    description:
      view === 'shows'
        ? 'Every podcast in the directory, newest show first.'
        : CATEGORY.lede,
    // Each page of each view canonicalises to itself: they hold different
    // episodes and different shows, so collapsing them would ask crawlers to
    // drop everything but the first sixty rows of one of them.
    alternates: { canonical: `${siteUrl()}${listHref(CATEGORY.path, view, page)}` },
    openGraph: { title, description: `Podcasts on RSS Amplifier — ${what}.` },
  };
}

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function PodcastsPage({ searchParams }) {
  const params = await searchParams;

  return (
    <CategoryIndex
      kind="podcast"
      page={pageNumber(params.page)}
      view={viewName(params.view, CATEGORY)}
    />
  );
}
