import OpenFramed from './OpenFramed.jsx';

/**
 * The toolbar that survives the article.
 *
 * The point of framing a post rather than linking straight out is that the bar
 * stays put: you can walk a blog's archive, or leave for the next blog, without
 * the back button and without ever landing on an index page. It is the same
 * roaming bar as the directory's, given the controls that make sense while
 * reading — so it is a sibling of Toolbar rather than a variant of it.
 *
 * Server-rendered plain links, like the other one: no JavaScript, nothing to
 * hydrate, and it works inside the reader shell on a phone. The one exception
 * is "Open ↗" on a framed post, and only because the frame can now be
 * navigated — see OpenFramed. Every other control here is still a plain link,
 * and the exception disappears the moment there is no frame.
 *
 * @param {{
 *   slug: string,
 *   feedTitle: string,
 *   postUrl?: string|null,
 *   framed?: boolean,
 *   prevGuid?: string|null,
 *   nextGuid?: string|null,
 *   nextBlog?: string|null,
 * }} props
 */
export default function ReaderToolbar({
  slug,
  feedTitle,
  postUrl,
  framed = false,
  prevGuid,
  nextGuid,
  nextBlog,
}) {
  const readerHref = (guid) => `/${slug}/read?p=${encodeURIComponent(guid)}`;

  return (
    <nav className="toolbar reader-toolbar" aria-label="Reading controls">
      <a href={`/${slug}`} title={`Back to ${feedTitle}`}>
        <span aria-hidden="true">←</span>
        <span className="label">Posts</span>
      </a>

      {prevGuid ? (
        <a href={readerHref(prevGuid)} aria-label="Newer post">
          <span className="label">Newer</span>
        </a>
      ) : (
        <span className="disabled" aria-hidden="true">
          <span className="label">Newer</span>
        </span>
      )}

      {nextGuid ? (
        <a href={readerHref(nextGuid)} aria-label="Older post">
          <span className="label">Older</span>
        </a>
      ) : (
        <span className="disabled" aria-hidden="true">
          <span className="label">Older</span>
        </span>
      )}

      <span className="sep" aria-hidden="true" />

      {postUrl &&
        // The framed page cannot be bookmarked or shared from the address bar,
        // so the escape hatch to the real article has to be explicit.
        (framed ? (
          <OpenFramed href={postUrl} />
        ) : (
          <a href={postUrl} target="_blank" rel="noopener" title="Open the original page">
            <span className="label">Open</span>
            <span aria-hidden="true">↗</span>
          </a>
        ))}

      <a className="primary" href={nextBlog ? `/${nextBlog}` : '/random'} title="Another blog">
        <span aria-hidden="true">✦</span>
        <span className="label">Next blog</span>
      </a>
    </nav>
  );
}
