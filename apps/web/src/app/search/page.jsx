import { db, siteUrl } from '../../lib/db.js';
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
  const { q = '' } = await searchParams;
  const query = q.trim();

  let blogs = [];
  let posts = [];

  if (query) {
    const sb = db();
    const [b, p] = await Promise.all([
      sb
        .from('feeds')
        .select('slug, title, description')
        .textSearch('search_tsv', query, { type: 'websearch', config: 'english' })
        .limit(20),
      sb
        .from('feed_items')
        .select('title, url, summary, published_at, feeds!inner(slug, title)')
        .textSearch('search_tsv', query, { type: 'websearch', config: 'english' })
        .order('published_at', { ascending: false, nullsFirst: false })
        .limit(40),
    ]);
    blogs = b.data ?? [];
    posts = p.data ?? [];
  }

  return (
    <>
      <h1>Search</h1>
      <p className="lede">
        Across every post we have collected. Quoted &ldquo;phrases&rdquo; and -exclusions work.
      </p>

      <form className="submit-box" method="get" action="/search">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="agentic coding, rss, self-hosting…"
          aria-label="Search query"
        />
        <p style={{ margin: '0.75rem 0 0' }}>
          <button type="submit">Search</button>
        </p>
      </form>

      {query && blogs.length === 0 && posts.length === 0 && (
        <p className="empty">
          Nothing for &ldquo;{query}&rdquo;. Try{' '}
          <a href={`https://kagi.com/search?q=${encodeURIComponent(query)}`} rel="noopener">
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
              <a className="feed-row" key={b.slug} href={`/${b.slug}`}>
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
                  <a href={p.url} rel="noopener">
                    {p.title}
                  </a>
                ) : (
                  p.title
                )}
              </h3>
              {p.summary && <p>{p.summary}</p>}
              <time>
                {p.feeds?.slug ? <a href={`/${p.feeds.slug}`}>{p.feeds.title}</a> : null}
              </time>
            </article>
          ))}
        </>
      )}

      {query && (
        <p style={{ marginTop: '2rem', fontSize: '0.9rem' }}>
          Also search{' '}
          <a href={`https://kagi.com/search?q=${encodeURIComponent(query)}`} rel="noopener">
            Kagi
          </a>{' '}
          — they index the small web too, and they may well have us.
        </p>
      )}

      <Toolbar current={query || null} />
    </>
  );
}
