import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../lib/db.js';
import { AD_TEXT, adPlan } from '../lib/ads.js';
import Ad from './Ad.jsx';
import AdBanner from './AdBanner.jsx';

/** Feeds per category page. Matches the home page's run length. */
export const PAGE_SIZE = 60;

/**
 * What the two categories are called, in one place.
 *
 * /blogs and /podcasts are the same page over a different filter, so they share
 * an implementation and differ only in this table — two copies of a directory
 * listing would drift the moment one of them grew a feature.
 */
export const CATEGORIES = {
  blog: {
    path: '/blogs',
    heading: 'Blogs',
    noun: 'blogs',
    one: 'blog',
    title: 'Blogs',
    lede: 'Independent writing, newest first. Every blog here has its own page, and the whole category is exportable as OPML.',
    schemaType: 'Blog',
  },
  podcast: {
    path: '/podcasts',
    heading: 'Podcasts',
    noun: 'podcasts',
    one: 'podcast',
    title: 'Podcasts',
    lede: 'Shows with audio in their feed, newest first. We sort a feed here when it carries an audio enclosure or the podcast namespaces — never because a submitter said so.',
    schemaType: 'PodcastSeries',
  },
};

/**
 * Read `?page=` as a 1-based page number.
 *
 * Anything unusable is page 1 rather than an error: the parameter is in a URL
 * people edit and share, and a directory listing has no reason to refuse to
 * render over it.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function pageNumber(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/**
 * One category of the directory, paged.
 *
 * @param {{ kind: 'blog'|'podcast', page?: number }} props
 */
export default async function CategoryIndex({ kind, page = 1 }) {
  const category = CATEGORIES[kind];
  const client = db();

  const [rows, total] = await Promise.all([
    q.listFeeds(client, { kind, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    q.countFeeds(client, false, kind),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const ads = adPlan(rows.length, { first: 11, every: 24, max: 2 });

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${category.heading} · RSS Amplifier`,
    description: category.lede,
    url: `${siteUrl()}${category.path}`,
    hasPart: rows.slice(0, 20).map((f) => ({
      '@type': category.schemaType,
      name: f.title,
      url: `${siteUrl()}/${f.slug}`,
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <h1>{category.heading}</h1>
      <p className="lede">{category.lede}</p>

      <Ad format={AD_TEXT} />

      <h2>
        {page === 1 ? 'Recently added' : `Page ${page}`}{' '}
        <span className="pill">
          {total} {total === 1 ? category.one : category.noun}
        </span>
      </h2>

      {rows.length === 0 ? (
        <p className="empty">
          {page === 1 ? (
            <>
              Nothing in this category yet. <a href="/submit">Add a feed</a> and the crawler will
              file it here if it belongs.
            </>
          ) : (
            <>
              This page is past the end of the list. <a href={category.path}>Back to the start.</a>
            </>
          )}
        </p>
      ) : (
        <div className="feed-list">
          {rows.flatMap((f, i) => {
            const row = (
              <a className="feed-row" key={String(f.slug)} href={`/${f.slug}`}>
                <h3>{f.title}</h3>
                {f.description && <p>{f.description}</p>}
                <div className="feed-meta">
                  {f.site_url && <span>{hostOf(String(f.site_url))}</span>}
                  <span>
                    {f.item_count} {kind === 'podcast' ? 'episodes' : 'posts'}
                  </span>
                </div>
              </a>
            );

            const format = ads.get(i);
            return format ? [row, <Ad key={`ad-${i}`} format={format} inFeed />] : [row];
          })}
        </div>
      )}

      {/* Plain links, both ends labelled: the pager is the only way through a
          category of this size without JavaScript, and a bare arrow says
          nothing to a screen reader or to a crawler deciding whether to follow
          it. */}
      {lastPage > 1 && (
        <nav className="pager" aria-label={`${category.heading} pages`}>
          {page > 1 ? (
            <a href={pageHref(category.path, page - 1)} rel="prev">
              ← Newer
            </a>
          ) : (
            <span className="disabled">← Newer</span>
          )}
          <span className="pill">
            Page {page} of {lastPage}
          </span>
          {page < lastPage ? (
            <a href={pageHref(category.path, page + 1)} rel="next">
              Older →
            </a>
          ) : (
            <span className="disabled">Older →</span>
          )}
        </nav>
      )}

      <p className="hint">
        Machine-readable: <a href={`/api/feeds?kind=${kind}`}>JSON</a> ·{' '}
        <a href={`/opml?kind=${kind}`}>OPML</a>
      </p>

      <AdBanner />
    </>
  );
}

/**
 * @param {string} path
 * @param {number} page
 * @returns {string}
 */
function pageHref(path, page) {
  // Page 1 is the bare path, never `?page=1`: the same listing under two URLs
  // is a duplicate-content signal to the crawlers this directory exists for.
  return page <= 1 ? path : `${path}?page=${page}`;
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
