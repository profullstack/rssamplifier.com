import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../lib/db.js';
import Toolbar from './Toolbar.jsx';

export const dynamic = 'force-dynamic';

/**
 * Directory index: newest blogs first, with the submit box up top.
 */
export default async function Home() {
  const client = db();
  const [rows, total] = await Promise.all([q.listFeeds(client, { limit: 60 }), q.countFeeds(client)]);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'RSS Amplifier',
    description: 'An open, agent-friendly directory of independent blogs.',
    url: siteUrl(),
    hasPart: rows.slice(0, 20).map((f) => ({
      '@type': 'Blog',
      name: f.title,
      url: `${siteUrl()}/${f.slug}`,
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <h1>An open directory of blogs, built for agents.</h1>
      <p className="lede">
        Drop in a URL, a list of URLs or an OPML file. We find the feed, read it, and give the blog
        a permanent page with its latest summaries. Everything here is also available as JSON, OPML
        and plain text — because the machines reading the web deserve a clean copy too.
      </p>

      <form className="submit-box" action="/api/submit" method="post">
        <p className="eyebrow">Add a blog</p>
        <textarea
          name="input"
          rows={3}
          placeholder={'example.com\nanotherblog.net/feed.xml'}
          aria-label="One or more URLs, one per line"
          required
        />
        <div className="submit-actions">
          <button type="submit">Add to the directory</button>
          <span className="pill">no account needed</span>
        </div>
      </form>

      <h2>
        Recently added <span className="pill">{total} blogs</span>
      </h2>

      {rows.length === 0 ? (
        <p className="empty">Nothing here yet. Be the first — paste a URL above.</p>
      ) : (
        <div className="feed-list">
          {rows.map((f) => (
            <a className="feed-row" key={String(f.slug)} href={`/${f.slug}`}>
              <h3>{f.title}</h3>
              {f.description && <p>{f.description}</p>}
              <div className="feed-meta">
                {f.site_url && <span>{hostOf(String(f.site_url))}</span>}
                <span>{f.item_count} posts</span>
              </div>
            </a>
          ))}
        </div>
      )}

      <Toolbar next={rows[0]?.slug ? String(rows[0].slug) : null} />
    </>
  );
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
