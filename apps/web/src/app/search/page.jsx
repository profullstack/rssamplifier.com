import { q } from '@rssamplifier/db';

import { db } from '../../lib/db.js';
import Toolbar from '../Toolbar.jsx';

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
                <h3>{b.title}</h3>
                {b.description && <p>{b.description}</p>}
              </a>
            ))}
          </div>
        </>
      )}

      {posts.length > 0 && (
        <>
          <h2>Posts</h2>
          {posts.map((p, i) => (
            <article className="entry" key={`${p.url ?? p.title}-${i}`}>
              <h3>
                {p.url ? (
                  <a href={String(p.url)} rel="noopener">
                    {p.title}
                  </a>
                ) : (
                  p.title
                )}
              </h3>
              {p.summary && <p>{p.summary}</p>}
              <time>
                <a href={`/${p.feed_slug}`}>{p.feed_title}</a>
              </time>
            </article>
          ))}
        </>
      )}

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
