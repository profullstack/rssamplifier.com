import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../lib/db.js';
import { AD_TEXT } from '../../lib/ads.js';
import Ad from '../Ad.jsx';
import AdBanner from '../AdBanner.jsx';
import { pageNumber } from '../CategoryIndex.jsx';
import ListFilter from '../ListFilter.jsx';
import { FILTER_FROM } from '../../lib/listFilter.js';

export const dynamic = 'force-dynamic';

/** Topics per page. A tag cloud is small type, so it takes far more than a list. */
const PAGE_SIZE = 300;

export async function generateMetadata({ searchParams }) {
  const page = pageNumber((await searchParams).page);

  return {
    title: page === 1 ? 'Topics' : `Topics · page ${page}`,
    description:
      'What the blogs and podcasts in the directory are about, from their own category tags and from the words they use.',
    alternates: {
      canonical: page === 1 ? `${siteUrl()}/topics` : `${siteUrl()}/topics?page=${page}`,
    },
  };
}

/**
 * The topics index.
 *
 * Ordered by how many feeds carry a topic rather than alphabetically: the point
 * of the page is to show what this directory is actually about, and an
 * alphabetical wall would bury that under whatever happens to start with "a".
 *
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function TopicsPage({ searchParams }) {
  const page = pageNumber((await searchParams).page);
  const client = db();

  const [topics, total] = await Promise.all([
    q.listTopics(client, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    q.countTopics(client),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <h1>Topics</h1>
      <p className="lede">
        What the directory is about, in its own words. A feed&rsquo;s topics come from the category
        tags its publisher wrote, and — since most publishers write none — from the phrases that
        recur across everything it has published.
      </p>

      <Ad format={AD_TEXT} />

      <h2>
        {page === 1 ? 'Most covered' : `Page ${page}`}{' '}
        <span className="pill">
          {total} {total === 1 ? 'topic' : 'topics'}
        </span>
      </h2>

      {/* Above the cloud, not beside the heading: three hundred chips is more
          than anyone scans, and someone here for one word in particular should
          meet the box before the wall. */}
      {topics.length >= FILTER_FROM && (
        <ListFilter target=".topic-cloud a" noun="topic" searchHref="/search?q=" />
      )}

      {topics.length === 0 ? (
        <p className="empty">
          No topics yet. They are extracted as the crawler works through the directory, and a topic
          appears here once a second feed shares it.
        </p>
      ) : (
        <div className="topic-cloud">
          {topics.map((t) => (
            <a key={String(t.slug)} href={`/topics/${encodeURIComponent(String(t.slug))}`}>
              {t.keyword}
              <span>{t.feed_count}</span>
            </a>
          ))}
        </div>
      )}

      {lastPage > 1 && (
        <nav className="pager" aria-label="Topic pages">
          {page > 1 ? (
            <a href={page === 2 ? '/topics' : `/topics?page=${page - 1}`} rel="prev">
              ← More covered
            </a>
          ) : (
            <span className="disabled">← More covered</span>
          )}
          <span className="pill">
            Page {page} of {lastPage}
          </span>
          {page < lastPage ? (
            <a href={`/topics?page=${page + 1}`} rel="next">
              Less covered →
            </a>
          ) : (
            <span className="disabled">Less covered →</span>
          )}
        </nav>
      )}

      <p className="hint">
        Machine-readable: <a href="/api/topics">JSON</a>
      </p>

      <AdBanner />
    </>
  );
}
