import './globals.css';

import { siteUrl } from '../lib/db.js';
import { SIGNED_IN_HINT_COOKIE } from '../lib/session-hint.js';
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
    // Two sizes rather than one: a browser tab picks the 192 and downscales it,
    // while an install prompt and the task switcher want the 512.
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon.png', sizes: '512x512', type: 'image/png' },
    ],
    // Opaque and pre-sized, because iOS composites a home-screen icon on white
    // and rounds the corners itself — a transparent PNG comes out ringed.
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
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

        {/* Ahead of the masthead, and synchronous, so a signed-in reader never
            sees "Sign up" painted and then taken away. It reads one cookie and
            sets one class; if it throws, or JavaScript is off, the nav is simply
            the signed-out one, which is the safe way round. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(document.cookie.split('; ').indexOf('${SIGNED_IN_HINT_COOKIE}=1')>-1)document.documentElement.classList.add('signed-in')}catch(e){}`,
          }}
        />

        <a className="skip-link" href="#main">
          Skip to content
        </a>

        <header className="masthead">
          <div className="masthead-inner">
            {/* A plain <img> rather than next/image: the wordmark is one fixed
                asset served from /public at a size the CSS already pins, so the
                optimiser has nothing to decide and would only put a render-
                blocking round trip in front of the first paint. Width and height
                are the intrinsic pixels, so the strip reserves its space before
                the file lands and the nav below it never jumps. */}
            <a className="wordmark" href="/">
              {/* Two files rather than one, because the logo's "Amplifier" half
                  is near-black and disappears into the dark palette. <picture>
                  rather than a CSS filter so each version keeps its own colour,
                  and rather than two <img>s so only the matching one is ever
                  fetched. The alt lives on the <img>, which is the element that
                  actually renders either way. */}
              <picture>
                <source srcSet="/logo-dark.png" media="(prefers-color-scheme: dark)" />
                <img src="/logo.png" alt="RSS Amplifier" width="532" height="96" />
              </picture>
            </a>

            {/* A checkbox rather than a button, so the menu opens with no
                JavaScript at all: the label toggles it and a sibling selector
                shows the nav. The nav is a plain list of links either way, so a
                wide screen never sees any of this — the label is hidden and the
                links lay out in a row exactly as before. */}
            <input
              className="nav-checkbox"
              type="checkbox"
              id="nav-open"
              aria-label="Show navigation"
            />
            <label className="nav-toggle" htmlFor="nav-open">
              <span aria-hidden="true">☰</span>
              <span className="label">Menu</span>
            </label>

            <nav aria-label="Primary">
              {/* The categories lead the nav: browsing is what a visitor came
                  for, and everything after Search is a thing you do once you
                  already know the site.

                  What is *not* here matters as much. OPML, llms.txt and About
                  each live in the footer, because on a phone this strip was
                  taller than the page it introduced, and a machine-readable
                  export is not something a reader reaches for on the way in. */}
              <a href="/blogs">Blogs</a>
              <a href="/news">News</a>
              <a href="/podcasts">Podcasts</a>
              <a href="/music">Music</a>
              <a href="/videos">Videos</a>
              <a href="/topics">Topics</a>
              <a href="/submit">Submit</a>
              <a href="/discover">Discover</a>
              <a href="/search">Search</a>
              {/* The one link that reflects whether anybody is signed in, and it
                  does so from CSS rather than from the server: reading the
                  session here would make every page in the directory dynamic.
                  The hint cookie set beside the session drives .signed-in on
                  <html>, which hides this.

                  It is carried in the nav at all because an account that is
                  only reachable from a page called "Sign in" reads, to somebody
                  who has never been here, like no account at all. Once you have
                  one it is the one item that can never apply to you.

                  The rest stay unconditional. /account sends a signed-out
                  visitor to /login and the shelves send them to sign in rather
                  than showing an empty room, so each costs at most one redirect
                  and the static pages stay static. */}
              <a className="nav-signup" href="/signup">
                Sign up
              </a>
              <a href="/following">Following</a>
              <a href="/favorites">Favorites</a>
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
              <a href="/about">About</a> · <a href="/contact">Contact</a> ·{' '}
              <a href="/privacy">Privacy</a> ·{' '}
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
