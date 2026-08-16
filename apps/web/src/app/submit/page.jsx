import Toolbar from '../Toolbar.jsx';

export const metadata = {
  title: 'Submit a blog',
  description: 'Add a URL, a list of URLs or an OPML file to the directory. No account needed.',
};

/**
 * @param {{ searchParams: Promise<{ error?: string, url?: string, input?: string, title?: string }> }} props
 */
export default async function SubmitPage({ searchParams }) {
  const params = await searchParams;

  // The PWA manifest declares a share_target pointing here, so sharing a link
  // from a phone lands as ?url= (or ?input= for shared text). Prefill from
  // either so the flow is one tap.
  const shared = (params.url ?? params.input ?? '').trim();

  return (
    <>
      <h1>Submit a blog</h1>
      <p className="lede">
        Paste a homepage and we will find the feed. No account, no waiting list, no fee.
      </p>

      {params.error && (
        <p className="notice">
          We could not find a feed at that address. Check the URL, or paste the feed link directly.
        </p>
      )}

      <form className="submit-box" action="/api/submit" method="post">
        <p className="eyebrow">One per line</p>
        <textarea
          name="input"
          rows={5}
          defaultValue={shared}
          placeholder={'example.com\nanotherblog.net/feed.xml'}
          aria-label="URLs to submit"
          required
        />
        <div className="submit-actions">
          <button type="submit">Add to the directory</button>
        </div>
      </form>

      <form className="submit-box" action="/api/submit" method="post" encType="multipart/form-data">
        <p className="eyebrow">Or upload an OPML file</p>
        <input type="file" name="opml" accept=".opml,.xml,text/xml" aria-label="OPML file" />
        <div className="submit-actions">
          <button type="submit">Import subscriptions</button>
        </div>
      </form>

      <h2>For agents</h2>
      <p>Same endpoint, JSON in and JSON out:</p>
      <pre className="snippet">{`curl -X POST https://rssamplifier.com/api/submit \\
  -H 'content-type: application/json' \\
  -d '{"urls":["example.com","another.blog"]}'`}</pre>

      <Toolbar />
    </>
  );
}
