import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../lib/db.js';
import { AD_TEXT } from '../../lib/ads.js';
import Ad from '../Ad.jsx';
import AdBanner from '../AdBanner.jsx';
import ListFilter from '../ListFilter.jsx';
import { FILTER_FROM } from '../../lib/listFilter.js';
import { pageNumber } from '../CategoryIndex.jsx';

export const dynamic = 'force-dynamic';

/** Topics per page. A tag cloud is small type, so it takes far more than a list. */
const PAGE_SIZE = 300;

/**
 * The search term from the URL, or the empty string.
 *
 * @param {string|string[]|undefined} raw
 * @returns {string}
 */
function term(raw) {
  return (Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).trim();
}

export async function generateMetadata({ searchParams }) {
  const params = await searchParams;
  const page = pageNumber(params.page);
  const query = term(params.q);

  const title = query
    ? `Topics matching “${query}”${page === 1 ? '' : ` · page ${page}`}`
    : page === 1
      ? 'Topics'
      : `Topics · page ${page}`;

  return {
    title,
    description:
      'What the blogs and podcasts in the directory are about, from their own category tags and from the words they use.',
    alternates: {
      canonical: `${siteUrl()}${topicsHref(page, query)}`,
    },
    // A search is one of forty thousand slices of a page that is already
    // indexed whole. Worth linking and following, not worth indexing.
    robots: query ? { index: false, follow: true } : undefined,
  };
}

/**
 * `/topics`, `/topics?page=2`, `/topics?q=homelab&page=2` — one href for all.
 *
 * @param {number} page
 * @param {string} query
 * @returns {string}
 */
function topicsHref(page, query) {
  const parts = [];
  if (query) parts.push(`q=${encodeURIComponent(query)}`);
  if (page > 1) parts.push(`page=${page}`);
  return parts.length ? `/topics?${parts.join('&')}` : '/topics';
}

/**
 * The topics index.
 *
 * Ordered by how many feeds carry a topic rather than alphabetically: the point
 * of the page is to show what this directory is actually about, and an
 * alphabetical wall would bury that under whatever happens to start with "a".
 *
 * Which is also why it needed a way in. Forty thousand topics ordered by feed
 * count is a hundred and thirty pages, so "does this directory know anything
 * about homelabs" was a question you could only answer by paging — and nobody
 * pages. Two filters answer it now, and they are deliberately different things:
 * the form below asks the database and comes back with a URL somebody can keep,
 * and {@link ListFilter} narrows the three hundred chips already rendered
 * without a round trip. The second is instant and can only see this page; when
 * it comes up empty it hands the term to the first.
 *
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function TopicsPage({ searchParams }) {
  const params = await searchParams;
  const page = pageNumber(params.page);
  const query = term(params.q);
  const client = db();

  const [topics, total] = await Promise.all([
    q.listTopics(client, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, query: query || null }),
    q.countTopics(client, 2, query || null),
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

      {/* A plain GET form, like every other control on the site: it works with
          JavaScript off and the result is a URL somebody can keep. */}
      <form className="submit-box" method="get" action="/topics">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="homelab, rust, gardening…"
          aria-label="Search topics"
        />
        <div className="submit-actions">
          <button type="submit">Search topics</button>
          {query && <a href="/topics">Clear</a>}
        </div>
      </form>

      <Ad format={AD_TEXT} />

      <h2>
        {query ? 'Matching' : page === 1 ? 'Most covered' : `Page ${page}`}{' '}
        <span className="pill">
          {total} {total === 1 ? 'topic' : 'topics'}
        </span>
      </h2>

      {/* On top of the form above rather than instead of it: that one asks the
          database and reloads, this one narrows the chips already rendered. */}
      {topics.length >= FILTER_FROM && (
        <ListFilter
          target=".topic-cloud a"
          noun="topic"
          placeholder="Filter these topics…"
          searchHref="/topics?q="
          searchLabel="Search every topic →"
        />
      )}

      {topics.length === 0 ? (
        <p className="empty">
          {query ? (
            <>
              No topic matches <strong>{query}</strong>. Topics are extracted from what publishers
              actually write, so a subject nobody in the directory covers has no page here.
            </>
          ) : (
            <>
              No topics yet. They are extracted as the crawler works through the directory, and a
              topic appears here once a second feed shares it.
            </>
          )}
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
            <a href={topicsHref(page - 1, query)} rel="prev">
              ← More covered
            </a>
          ) : (
            <span className="disabled">← More covered</span>
          )}
          <span className="pill">
            Page {page} of {lastPage}
          </span>
          {page < lastPage ? (
            <a href={topicsHref(page + 1, query)} rel="next">
              Less covered →
            </a>
          ) : (
            <span className="disabled">Less covered →</span>
          )}
        </nav>
      )}

      <p className="hint">
        Machine-readable:{' '}
        <a href={query ? `/api/topics?q=${encodeURIComponent(query)}` : '/api/topics'}>JSON</a>
      </p>

      <AdBanner />
    </>
  );
}
