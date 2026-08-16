import { MAX_KEYWORDS } from '@rssamplifier/search';

import { AD_TEXT } from '../../lib/ads.js';
import Ad from '../Ad.jsx';
import Toolbar from '../Toolbar.jsx';

export const metadata = {
  title: 'Find blogs by keyword',
  description:
    'Type a subject and we search the web for blogs about it, check their feeds, and add the good ones to the directory. One keyword or a hundred.',
};

/**
 * Keyword discovery, the front door.
 *
 * Submission needs you to already know a blog exists. This is the other half of
 * growing a directory: name a subject and let the search engine find the blogs
 * you have never heard of.
 *
 * @param {{ searchParams: Promise<{ error?: string }> }} props
 */
export default async function DiscoverPage({ searchParams }) {
  const params = await searchParams;

  return (
    <>
      <h1>Find blogs by keyword</h1>
      <p className="lede">
        Type a subject. We search the web for it, look for a feed on every site that comes back, and
        add the ones that turn out to be real blogs.
      </p>

      {params.error === 'empty' && (
        <p className="notice">Enter at least one keyword — a phrase like “siberian huskies”.</p>
      )}
      {params.error === 'rate' && (
        <p className="notice">
          That is enough searching for one hour. Each keyword costs a search credit, so the limit is
          real rather than decorative. Try again later.
        </p>
      )}

      <form className="submit-box" action="/api/discover" method="post">
        <p className="eyebrow">One keyword per line, up to {MAX_KEYWORDS}</p>
        <textarea
          name="keywords"
          rows={6}
          placeholder={'siberian huskies\nsourdough baking\nretro computing'}
          aria-label="Keywords to search for"
          required
        />
        <p className="hint">
          The first {MAX_KEYWORDS} sites we find are checked while you wait; everything past that is
          queued for the crawler. You will get a status page either way.
        </p>
        <input
          type="email"
          name="email"
          placeholder="you@example.com — optional, we will email you when it finishes"
          aria-label="Email me when the search finishes"
        />
        <div className="submit-actions">
          <button type="submit">Find blogs</button>
        </div>
      </form>

      <h2>What gets added</h2>
      <p>
        Not everything a search returns is a blog. A site is only added if a feed can be found on it
        and that feed looks like a publication: several entries, posted this side of about eighteen
        months ago, with titles that differ from one another and links that go somewhere. Comment
        feeds, tag feeds, shops and the big platforms are dropped before we ever fetch them.
      </p>

      <h2>For agents</h2>
      <p>Same endpoint, JSON in and JSON out:</p>
      <pre className="snippet">{`curl -X POST https://rssamplifier.com/api/discover \\
  -H 'content-type: application/json' \\
  -d '{"keywords":["siberian huskies"]}'`}</pre>

      <Ad format={AD_TEXT} />

      <Toolbar />
    </>
  );
}
