import { siteUrl } from '../lib/db.js';
import { directoryIndex } from '../lib/directory.js';
import { feedAlternates } from '../lib/subscribe.js';
import { AD_TEXT, adPlan } from '../lib/ads.js';
import Ad from './Ad.jsx';
import AdBanner from './AdBanner.jsx';
import SubscribeLinks from './SubscribeLinks.jsx';
import { Avatar } from './Thumb.jsx';
import { feedImage } from '../lib/thumbs.js';
import Toolbar from './Toolbar.jsx';
import { CATEGORIES } from './CategoryIndex.jsx';
import ListFilter from './ListFilter.jsx';
import { FILTER_FROM } from '../lib/listFilter.js';
import { jsonLdScript } from '../lib/jsonld.js';

export const dynamic = 'force-dynamic';

/**
 * The homepage had neither a canonical URL nor an og:url, so every way of
 * arriving at the directory — with a tracking parameter, on the bare apex, from
 * a shared link — looked to a crawler like a page in its own right.
 *
 * Declared here rather than in the layout on purpose: metadata is inherited, so
 * a canonical of '/' in the layout would tell every page in the site that it is
 * really the homepage. openGraph is restated in full because a child replaces
 * the parent's block rather than merging into it, and dropping type and
 * siteName to add url would be a poor trade. og:title, og:description and the
 * card from opengraph-image.jsx still come from the layout and the file.
 */
export const metadata = {
  alternates: {
    canonical: '/',
    // The whole directory as a feed. A relative base here for the same reason
    // the canonical is relative: Next resolves both against metadataBase.
    types: feedAlternates('/feed', 'New in RSS Amplifier'),
  },
  openGraph: {
    type: 'website',
    siteName: 'RSS Amplifier',
    url: '/',
  },
};

/**
 * Directory index: newest blogs first, with the submit box up top.
 */
export default async function Home() {
  // Cached in Redis and served stale on failure. Two of these three reads are
  // whole-table work at half a million feeds, and uncached they answered this
  // URL with a 500 whenever the database was busy — see ../lib/directory.js.
  const { rows, total, byKind } = await directoryIndex();

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
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
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

      {/* The directory itself, as a feed: everything added to it, newest
          first. `/feed.rss` rather than `/.rss`, which is not an address. */}
      <SubscribeLinks base="/feed" what="the directory" />

      {/* The index below is everything, newest first. These are the two ways
          into it that are worth having their own page — the counts are the
          point, because they say what the directory is mostly made of. */}
      <nav className="categories" aria-label="Categories">
        {Object.entries(CATEGORIES).map(([kind, category]) => (
          <a key={kind} href={category.path}>
            <strong>{category.heading}</strong>
            <span>{byKind[kind] === 1 ? '1 feed' : `${byKind[kind] ?? 0} feeds`}</span>
          </a>
        ))}
      </nav>

      {/* Below the categories on purpose: browsing is what most visitors came
          to do, and the terminal is for the minority who would rather not be
          here at all. One line, so it costs the scroll almost nothing. */}
      <section className="install-strip">
        <div>
          <p className="eyebrow">Prefer a terminal?</p>
          <p>
            Find feeds by subject, search every post and export OPML from the command line — or
            from a script, or an agent already driving a shell.
          </p>
        </div>
        <div>
          <pre className="code-block">
            <code>{`curl -fsSL ${siteUrl()}/install.sh | sh`}</code>
          </pre>
          <p className="install-links">
            <a href="/cli">Documentation</a> · <a href="/mcp">MCP server</a> ·{' '}
            <a href="/llms.txt">llms.txt</a>
          </p>
        </div>
      </section>

      <h2>
        Recently added <span className="pill">{total} blogs</span>
      </h2>

      {rows.length >= FILTER_FROM && (
        <ListFilter target=".feed-list .feed-row" noun="blog" searchHref="/search?q=" />
      )}

      {rows.length === 0 ? (
        <p className="empty">Nothing here yet. Be the first — paste a URL above.</p>
      ) : (
        <div className="feed-list">
          {rows.flatMap((f, i) => {
            const row = (
              <a className="feed-row" key={String(f.slug)} href={`/${f.slug}`}>
                {/* Cover art where the feed publishes any, its initial where it
                    does not — three quarters of the directory is the second
                    case, so the column is always there and never empty. */}
                <Avatar src={feedImage(f)} title={f.title} slug={f.slug} />
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
