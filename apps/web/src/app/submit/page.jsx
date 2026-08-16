import Toolbar from '../Toolbar.jsx';

export const metadata = {
  title: 'Submit a blog',
  description: 'Add a URL, a list of URLs or an OPML file to the directory. No account needed.',
};

/**
 * @param {{ searchParams: Promise<{ error?: string }> }} props
 */
export default async function SubmitPage({ searchParams }) {
  const { error } = await searchParams;

  return (
    <>
      <h1>Submit a blog</h1>
      <p className="lede">
        Paste a homepage and we will find the feed. No account, no waiting list, no fee.
      </p>

      {error && (
        <p className="notice">
          We could not find a feed at that address. Check the URL, or paste the feed link directly.
        </p>
      )}

      <form className="submit-box" action="/api/submit" method="post">
        <p className="eyebrow">One per line</p>
        <textarea
          name="input"
          rows={6}
          placeholder={'example.com\nanotherblog.net/feed.xml'}
          aria-label="URLs to submit"
          required
        />
        <p style={{ margin: '0.75rem 0 0' }}>
          <button type="submit">Add to the directory</button>
        </p>
      </form>

      <form className="submit-box" action="/api/submit" method="post" encType="multipart/form-data">
        <p className="eyebrow">Or upload an OPML file</p>
        <input type="file" name="opml" accept=".opml,.xml,text/xml" aria-label="OPML file" />
        <p style={{ margin: '0.75rem 0 0' }}>
          <button type="submit">Import subscriptions</button>
        </p>
      </form>

      <h2>For agents</h2>
      <p>Same endpoint, JSON in and JSON out:</p>
      <pre
        style={{
          fontFamily: 'var(--mono)',
          fontSize: '0.82rem',
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: '8px',
          padding: '1rem',
          overflowX: 'auto',
        }}
      >{`curl -X POST https://rssamplifier.com/api/submit \\
  -H 'content-type: application/json' \\
  -d '{"urls":["example.com","another.blog"]}'`}</pre>

      <Toolbar />
    </>
  );
}
