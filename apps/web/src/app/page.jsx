import { db, siteUrl } from '../lib/db.js';
import Toolbar from './Toolbar.jsx';

export const dynamic = 'force-dynamic';

/**
 * Directory index: newest blogs first, with the submit box up top.
 */
export default async function Home() {
  const sb = db();

  const { data: feeds } = await sb
    .from('feeds')
    .select('slug, title, description, site_url, item_count, last_success_at')
    .neq('status', 'dead')
    .order('created_at', { ascending: false })
    .limit(60);

  const { count } = await sb.from('feeds').select('id', { count: 'exact', head: true });

  const rows = feeds ?? [];

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
          placeholder={'example.com\nanotherblog.net/feed.xml\nhttps://third.blog/atom.xml'}
          aria-label="One or more URLs, one per line"
          required
        />
        <p style={{ margin: '0.75rem 0 0', display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <button type="submit">Add to the directory</button>
          <span className="pill">no account needed</span>
        </p>
      </form>

      <h2>
        Recently added{' '}
        {typeof count === 'number' && <span className="pill">{count} blogs</span>}
      </h2>

      {rows.length === 0 ? (
        <p className="empty">Nothing here yet. Be the first — paste a URL above.</p>
      ) : (
        <div className="feed-list">
          {rows.map((f) => (
            <a className="feed-row" key={f.slug} href={`/${f.slug}`}>
              <h3>{f.title}</h3>
              {f.description && <p>{f.description}</p>}
              <div className="feed-meta">
                {f.site_url && <span>{hostOf(f.site_url)}</span>}
                <span>{f.item_count} posts</span>
              </div>
            </a>
          ))}
        </div>
      )}

      <Toolbar next={rows[0]?.slug ?? null} />
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
