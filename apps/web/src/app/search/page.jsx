import { q } from '@rssamplifier/db';

import { db } from '../../lib/db.js';
import { AD_MREC, AD_TEXT, adPlan } from '../../lib/ads.js';
import Ad from '../Ad.jsx';
import AdBanner from '../AdBanner.jsx';
import Thumb, { Avatar } from '../Thumb.jsx';
import Toolbar from '../Toolbar.jsx';
import { postThumb } from '../../lib/thumbs.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Search',
  description: 'Full-text search across every blog and post in the directory.',
};

/**
 * @param {{ searchParams: Promise<{ q?: string }> }} props
 */
export default async function SearchPage({ searchParams }) {
  const params = await searchParams;
  const query = (params.q ?? '').trim();

  let blogs = [];
  let posts = [];

  if (query) {
    const client = db();
    [blogs, posts] = await Promise.all([
      q.searchFeeds(client, query, 20),
      q.searchItems(client, query, 40),
    ]);
  }

  const kagi = `https://kagi.com/search?q=${encodeURIComponent(query)}`;

  // Somebody who has typed a query has told us what they want, which makes this
  // the most valuable page on the site — and the easiest one to ruin. So: a
  // blank /search carries no advertising at all (there is nothing to be
  // relevant to), a search that found nothing carries exactly one line, and a
  // search that found something carries the full set.
  const found = blogs.length > 0 || posts.length > 0;
  const postAds = adPlan(posts.length, { first: 8, every: 20, max: 2, formats: [AD_TEXT] });

  return (
    <>
      <h1>Search</h1>
      <p className="lede">Across every post we have collected.</p>

      <form className="submit-box" method="get" action="/search">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="agentic coding, rss, self-hosting…"
          aria-label="Search query"
        />
        <div className="submit-actions">
          <button type="submit">Search</button>
        </div>
      </form>

      {/*
       * Directly under the box, above the results: the sponsored-result
       * position, and the strongest one on any search page. It stays a text
       * link so it reads as an offer rather than as the first result.
       */}
      {query && <Ad format={AD_TEXT} />}

      {query && blogs.length === 0 && posts.length === 0 && (
        <p className="empty">
          Nothing for &ldquo;{query}&rdquo;. Try{' '}
          <a href={kagi} rel="noopener">
            Kagi
          </a>{' '}
          instead.
        </p>
      )}

      {blogs.length > 0 && (
        <>
          <h2>Blogs</h2>
          <div className="feed-list">
            {blogs.map((b) => (
              <a className="feed-row" key={String(b.slug)} href={`/${b.slug}`}>
                <Avatar src={b.image_url} title={b.title} slug={b.slug} />
                <h3>{b.title}</h3>
                {b.description && <p>{b.description}</p>}
              </a>
            ))}
          </div>
        </>
      )}

      {/* Between the two result sets — a natural break, so a box fits here. */}
      {blogs.length > 0 && posts.length > 0 && <Ad format={AD_MREC} />}

      {posts.length > 0 && (
        <>
          <h2>Posts</h2>
          {posts.flatMap((p, i) => {
            // A result goes to our reader, not straight off the site: the post
            // is framed with the toolbar still on screen, and the way out to
            // the original lives down there rather than being the only option.
            // Needs a guid to address; without one there is nothing to link to.
            const href = p.guid
              ? `/${p.feed_slug}/read?p=${encodeURIComponent(String(p.guid))}`
              : null;

            const thumb = postThumb(p);

            const entry = (
              <article
                className={thumb ? 'entry has-thumb' : 'entry'}
                key={`${p.guid ?? p.url ?? p.title}-${i}`}
              >
                <Thumb src={thumb} href={href} />

                <h3>{href ? <a href={href}>{p.title}</a> : p.title}</h3>
                {p.summary && <p>{p.summary}</p>}
                <time>
                  <a href={`/${p.feed_slug}`}>{p.feed_title}</a>
                </time>
              </article>
            );

            const format = postAds.get(i);
            return format ? [entry, <Ad key={`ad-${i}`} format={format} />] : [entry];
          })}
        </>
      )}

      {found && <AdBanner />}

      {query && (
        <p className="also-search">
          Also search{' '}
          <a href={kagi} rel="noopener">
            Kagi
          </a>{' '}
          — they index the small web too.
        </p>
      )}

      <Toolbar current={query || null} />
    </>
  );
}
