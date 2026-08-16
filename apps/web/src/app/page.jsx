import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../lib/db.js';
import { AD_TEXT, adPlan } from '../lib/ads.js';
import Ad from './Ad.jsx';
import AdBanner from './AdBanner.jsx';
import Toolbar from './Toolbar.jsx';

export const dynamic = 'force-dynamic';

/**
 * Directory index: newest blogs first, with the submit box up top.
 */
export default async function Home() {
  const client = db();
  const [rows, total] = await Promise.all([q.listFeeds(client, { limit: 60 }), q.countFeeds(client)]);

  // The index is a long scan, so ads go *between* rows rather than around the
  // list. First one is deep enough that the fold is all directory, and there
  // are at most two however far the list runs.
  const ads = adPlan(rows.length, { first: 11, every: 24, max: 2 });

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

      {/*
       * Below the submit box, never above it: the form is what this page is
       * for. A text link is the only format that can sit here at all — it is a
       * line of type, so it costs the fold 40px rather than a 250px block.
       */}
      <Ad format={AD_TEXT} />

      <h2>
        Recently added <span className="pill">{total} blogs</span>
      </h2>

      {rows.length === 0 ? (
        <p className="empty">Nothing here yet. Be the first — paste a URL above.</p>
      ) : (
        <div className="feed-list">
          {rows.flatMap((f, i) => {
            const row = (
              <a className="feed-row" key={String(f.slug)} href={`/${f.slug}`}>
                <h3>{f.title}</h3>
                {f.description && <p>{f.description}</p>}
                <div className="feed-meta">
                  {f.site_url && <span>{hostOf(String(f.site_url))}</span>}
                  <span>{f.item_count} posts</span>
                </div>
              </a>
            );

            const format = ads.get(i);
            return format ? [row, <Ad key={`ad-${i}`} format={format} inFeed />] : [row];
          })}
        </div>
      )}

      <AdBanner />

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
