import './globals.css';

import { siteUrl } from '../lib/db.js';
import DockPlayer from './DockPlayer.jsx';
import ServiceWorker from './ServiceWorker.jsx';
import Script from "next/script";

export const metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: 'RSS Amplifier — an open directory of blogs, built for agents',
    template: '%s · RSS Amplifier',
  },
  description:
    'Submit a URL, a list of URLs or an OPML file. Every blog gets its own page, and the whole directory is available as JSON, OPML and plain text for AI agents.',
  applicationName: 'RSS Amplifier',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'RSS Amplifier',
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
  openGraph: {
    type: 'website',
    siteName: 'RSS Amplifier',
  },
};

export const viewport = {
  // Mobile-first: fill the notch area, and let the theme colour follow the
  // light/dark palette rather than pinning one of them.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf8' },
    { media: '(prefers-color-scheme: dark)', color: '#12110f' },
  ],
};

/**
 * Who the site is and what it is, once, for every page.
 *
 * The pages already describe *themselves* — a feed page carries Blog, the
 * indexes carry CollectionPage — but nothing said what the site as a whole is
 * or who publishes it, so an agent reading one page had no way to attribute it.
 * These two nodes are stable across the site, so they belong in the layout
 * rather than being restated per page; the per-page JSON-LD stays where it is
 * and the @id here is what those pages can be understood to belong to.
 *
 * The SearchAction is the useful half: it tells an agent that /search?q= is the
 * way in, instead of leaving it to crawl the indexes a page at a time.
 */
function siteJsonLd() {
  const url = siteUrl();

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${url}/#organization`,
        name: 'Profullstack, Inc.',
        url: 'https://profullstack.com',
      },
      {
        '@type': 'WebSite',
        '@id': `${url}/#website`,
        name: 'RSS Amplifier',
        description:
          'An open, agent-friendly directory of independent blogs, podcasts, music and video feeds.',
        url,
        inLanguage: 'en',
        publisher: { '@id': `${url}/#organization` },
        potentialAction: {
          '@type': 'SearchAction',
          target: {
            '@type': 'EntryPoint',
            urlTemplate: `${url}/search?q={search_term_string}`,
          },
          'query-input': 'required name=search_term_string',
        },
      },
    ],
  };
}

/**
 * @param {{ children: React.ReactNode }} props
 */
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd()) }}
        />

        <a className="skip-link" href="#main">
          Skip to content
        </a>

        <header className="masthead">
          <div className="masthead-inner">
            <a className="wordmark" href="/">
              RSS<span>Amplifier</span>
            </a>
            <nav aria-label="Primary">
              {/* The two categories lead the nav: browsing is what a visitor
                  came to do, and everything after Search is a thing you do once
                  you already know the site. */}
              <a href="/blogs">Blogs</a>
              <a href="/news">News</a>
              <a href="/podcasts">Podcasts</a>
              <a href="/music">Music</a>
              <a href="/videos">Videos</a>
              <a href="/topics">Topics</a>
              <a href="/submit">Submit</a>
              <a href="/discover">Discover</a>
              <a href="/search">Search</a>
              <a href="/opml">OPML</a>
              <a href="/llms.txt">llms.txt</a>
              <a href="/about">About</a>
              {/* Both of these are unconditional, and neither reflects whether
                  anybody is signed in: telling those apart means reading the
                  session cookie here, which would make every page in the site
                  dynamic. /account sends a signed-out visitor to /login and
                  /signup sends a signed-in one back to /account, so each costs
                  at most one redirect and the static pages stay static.

                  "Sign up" is carried in the nav because an account that is
                  only reachable from a page called "Sign in" reads, to somebody
                  who has never been here, like no account at all. */}
              <a href="/signup">Sign up</a>
              {/* Like /account, unconditional: a signed-out visitor is sent to
                  sign in rather than being shown an empty shelf. */}
              <a href="/favorites">Favorites</a>
              {/* Same argument as Favorites: unconditional, so the nav stays
                  the same on every page and none of them has to read a cookie
                  to draw it. */}
              <a href="/queue">Queue</a>
              <a href="/account">Account</a>
            </nav>
          </div>
        </header>

        <main className="wrap" id="main">
          {children}
        </main>

        <footer className="site">
          <div className="wrap">
            <p>
              An open, agent-friendly directory of independent blogs. Anyone can add a feed; no
              account needed. Built by <a href="https://profullstack.com">Profullstack, Inc.</a>
            </p>
            <p>
              Browse: <a href="/blogs">Blogs</a> · <a href="/news">News</a> ·{' '}
              <a href="/podcasts">Podcasts</a> ·{' '}
              <a href="/music">Music</a> · <a href="/videos">Videos</a> ·{' '}
              <a href="/comics">Comics</a> · <a href="/lives">Live</a> ·{' '}
              <a href="/reels">Reels</a> · <a href="/topics">Topics</a>
            </p>
            <p>
              Machine-readable: <a href="/mcp">MCP server</a> · <a href="/api/feeds">JSON API</a> ·{' '}
              <a href="/opml">OPML</a> · <a href="/llms.txt">llms.txt</a> ·{' '}
              <a href="/crawlstats">Crawler status</a>
            </p>
            <p>
              <a href="/about">About</a> · <a href="/privacy">Privacy</a> ·{' '}
              <a href="https://github.com/profullstack/rssamplifier.com" rel="noopener">
                Source on GitHub
              </a>
            </p>
          </div>
        </footer>

        {/* The player, in the layout rather than in a page, because that is the
            difference between one that follows you around the directory and one
            that dies with the post you started it from. It renders nothing at
            all until a page hands it something to play. */}
        <DockPlayer />

        <ServiceWorker />

        <Script
          data-site="98aa7ae4-f205-4cf3-8c0f-40182ea3638e"
          src="https://crawlproof.com/stats.js"
          strategy="afterInteractive"
        />

        {/*
         * The ad loader, once for the site. It only ever acts on the
         * [data-cp-ad] positions the pages themselves place (<Ad> and
         * <AdBanner>) — there are deliberately none here, because a unit in the
         * root layout is a unit on the submit form and on the offline page too.
         */}
        <Script src="https://crawlproof.com/ad.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
