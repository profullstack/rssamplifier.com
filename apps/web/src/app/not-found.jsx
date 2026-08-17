export const metadata = {
  title: 'Not found',
  description: 'That page is not here.',
  // A 404 that gets indexed is a 404 in the search results. Next serves this
  // with a real 404 status, but the meta tag costs nothing and covers the
  // crawlers that reach it another way.
  robots: { index: false, follow: true },
};

/**
 * The 404 page.
 *
 * Most misses here are a feed slug that never existed or one that was removed,
 * so the way forward is a search box rather than an apology — the visitor
 * usually knows the name of the thing they wanted.
 */
export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p className="lede">
        There is no page at that address. It may have been a feed that has since been removed, or a
        link that was mistyped on the way here.
      </p>

      <form className="submit-box" method="get" action="/search">
        <input
          type="search"
          name="q"
          placeholder="Search for it by name…"
          aria-label="Search the directory"
        />
        <div className="submit-actions">
          <button type="submit">Search</button>
        </div>
      </form>

      <p>
        Or start from the <a href="/">directory</a>, the <a href="/topics">topics</a>, or{' '}
        <a href="/submit">add the feed</a> if it is not here yet.
      </p>
    </>
  );
}
