'use client';

/**
 * The 500 page.
 *
 * Deliberately says nothing about what broke. `error.message` on a server
 * exception is replaced by React with an opaque digest in production, but the
 * digest is still an internal identifier and putting it on the page invites it
 * into screenshots and search results; it is already in the server logs, which
 * is where it is useful. What the visitor gets instead is the one thing that
 * sometimes works — a retry — because most failures here are a database read
 * that timed out rather than a page that is genuinely gone.
 *
 * @param {{ error: Error & { digest?: string }, reset: () => void }} props
 */
export default function Error({ reset }) {
  return (
    <>
      <h1>Something went wrong</h1>
      <p className="lede">
        This page could not be built just now. It is our end, not yours, and it is usually
        temporary.
      </p>
      <p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </p>
      <p>
        If it keeps happening, the <a href="/crawlstats">crawler status board</a> shows whether the
        directory is behaving, and <a href="/">the front page</a> is always the safe way back.
      </p>
    </>
  );
}
