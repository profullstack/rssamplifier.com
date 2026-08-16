import { AD_MREC } from '../../lib/ads.js';
import Ad from '../Ad.jsx';
import Toolbar from '../Toolbar.jsx';

export const metadata = {
  title: 'About',
  description: 'What RSS Amplifier is, and why it is deliberately open to AI crawlers.',
};

export default function AboutPage() {
  return (
    <>
      <h1>About</h1>
      <p className="lede">
        RSS Amplifier is an open directory of independent blogs. Submit a URL, a list of URLs or an
        OPML file; we find the feed, read it, and give the blog a permanent page.
      </p>

      <h2>Why it exists</h2>
      <p>
        The independent web is still there — it is just hard to find, and increasingly hard for
        anything automated to read. Most large sites now block AI crawlers outright. We do the
        opposite: every page here is open, and the whole directory is published as JSON, OPML and
        plain text so an agent can read it in one request.
      </p>

      <h2>How feeds get in</h2>
      <p>
        Anyone can add one, with no account. We resolve a homepage to its feed by reading{' '}
        <code>&lt;link rel=&quot;alternate&quot;&gt;</code> tags first, then trying the conventional
        paths. RSS, Atom and JSON Feed all work. Feeds are re-crawled hourly, backing off when a
        host stops responding, and a feed that fails ten times running stops being crawled while its
        archive page stays up.
      </p>

      <h2>What we store</h2>
      <p>
        Feed metadata and the summaries the feed itself publishes — the same thing any reader would
        show. Posts link back to the author&apos;s own site; we are a directory, not a mirror. If
        you would rather not be listed, mail us and we will remove it.
      </p>

      <h2>Machine-readable</h2>
      <ul>
        <li>
          <a href="/llms.txt">/llms.txt</a> — the directory, described for language models
        </li>
        <li>
          <a href="/api/feeds">/api/feeds</a> — every blog, paginated JSON
        </li>
        <li>
          <a href="/api/search?q=rss">/api/search?q=</a> — full-text search
        </li>
        <li>
          <a href="/opml">/opml</a> — the whole directory as a subscription list
        </li>
      </ul>
      <p>All of them send an open CORS header and need no key.</p>

      {/* One unit, at the end. Anyone who read this far is engaged; nobody
          arriving at an About page is in a hurry to be sold to on the way in. */}
      <Ad format={AD_MREC} />

      <Toolbar />
    </>
  );
}
