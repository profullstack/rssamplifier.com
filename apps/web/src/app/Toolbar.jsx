/**
 * The roaming toolbar.
 *
 * Kagi Small Web puts a chunky pixel bar on the page; this is the same idea —
 * keep moving through the directory without going back to an index — rendered
 * as a single quiet pill. Server-rendered plain links, so it works with
 * JavaScript off and costs nothing on load.
 *
 * @param {{ prev?: string|null, next?: string|null, current?: string|null, siteUrl?: string|null, feedUrl?: string|null }} props
 */
export default function Toolbar({ prev, next, current, siteUrl, feedUrl }) {
  return (
    <nav className="toolbar" aria-label="Browse the directory">
      <a href={prev ? `/${prev}` : '/'} aria-label={prev ? 'Previous blog' : 'Directory'}>
        <span aria-hidden="true">←</span>
        <span className="label">{prev ? 'Prev' : 'Index'}</span>
      </a>

      <a className="primary" href="/random" aria-label="Random blog">
        <span aria-hidden="true">✦</span>
        <span className="label">Random</span>
      </a>

      <a href={next ? `/${next}` : '/'} aria-label={next ? 'Next blog' : 'Directory'}>
        <span className="label">{next ? 'Next' : 'Index'}</span>
        <span aria-hidden="true">→</span>
      </a>

      {(siteUrl || feedUrl) && <span className="sep" aria-hidden="true" />}

      {siteUrl && (
        <a href={siteUrl} rel="noopener" title="Open the blog itself">
          <span className="label">Visit</span>
          <span aria-hidden="true">↗</span>
        </a>
      )}

      {feedUrl && (
        <a href={feedUrl} type="application/rss+xml" title="Subscribe to this feed">
          <span className="label">Feed</span>
        </a>
      )}

      {current && (
        <a
          href={`https://kagi.com/search?q=${encodeURIComponent(current)}`}
          rel="noopener"
          title="Search Kagi for this blog"
        >
          <span className="label">Kagi</span>
          <span aria-hidden="true">↗</span>
        </a>
      )}
    </nav>
  );
}
