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
    // Pre-cut at every size that gets asked for, rather than one big file the
    // client downscales. A tab is 16 or 32 physical pixels: handed the 512 it
    // renders the mark as mud, and handed the 1254px source artwork it spends
    // 450kB of the first paint's budget on a 16px square. The install prompt and
    // the task switcher are the ones that actually want the large end.
    icon: [
      { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-48x48.png', sizes: '48x48', type: 'image/png' },
      { url: '/icons/icon-128x128.png', sizes: '128x128', type: 'image/png' },
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-256x256.png', sizes: '256x256', type: 'image/png' },
      { url: '/icons/icon-384x384.png', sizes: '384x384', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    // The .ico stays listed *and* sits at the site root, because the two are
    // different requests: this link serves a browser that reads the markup, and
    // the root copy serves everything that asks for /favicon.ico without ever
    // having parsed a page — feed readers, link unfurlers, an old bookmark bar.
    shortcut: [{ url: '/favicon.ico', type: 'image/x-icon' }],
    // All nine come off /favicon.png, the master the whole set is cut from, but
    // flattened rather than resized: a home-screen icon is the same mark drawn
    // for a different surface. iOS composites it on its own ground and rounds
    // the corners itself, so it wants these opaque on #fbfaf8 and inset far
    // enough that the rounding cannot clip the megaphone. The favicon cuts above
    // are transparent and edge-to-edge, which is right for a 16px tab and wrong
    // here; /apple-icon.png at the root is a copy of the 180 below, for the
    // clients that look for that name without reading the markup.
    // The small end is not dead weight either: an iPhone old enough
    // to ask for the 57 takes the *first* apple-touch-icon it can use rather
    // than the best fit, which is why this list runs largest to smallest.
    apple: [
      { url: '/icons/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png' },
      { url: '/icons/apple-touch-icon-152x152.png', sizes: '152x152', type: 'image/png' },
      { url: '/icons/apple-touch-icon-144x144.png', sizes: '144x144', type: 'image/png' },
      { url: '/icons/apple-touch-icon-120x120.png', sizes: '120x120', type: 'image/png' },
      { url: '/icons/apple-touch-icon-114x114.png', sizes: '114x114', type: 'image/png' },
      { url: '/icons/apple-touch-icon-76x76.png', sizes: '76x76', type: 'image/png' },
      { url: '/icons/apple-touch-icon-72x72.png', sizes: '72x72', type: 'image/png' },
      { url: '/icons/apple-touch-icon-60x60.png', sizes: '60x60', type: 'image/png' },
      { url: '/icons/apple-touch-icon-57x57.png', sizes: '57x57', type: 'image/png' },
    ],
  },
  // The tags Next has no field for. Chromium reads the unprefixed
  // mobile-web-app-capable and warns about the apple- one that `appleWebApp`
  // above emits, so both are wanted rather than either; the msapplication trio
  // is what a pinned tile on Windows reads, and TileColor is repeated here
  // because the tile is drawn before browserconfig.xml has been fetched.
  other: {
    'mobile-web-app-capable': 'yes',
    'msapplication-TileColor': '#fbfaf8',
    'msapplication-TileImage': '/icons/apple-touch-icon-144x144.png',
    'msapplication-config': '/browserconfig.xml',
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

        {/* One listener for every thumbnail on the page.
         *
         * A directory of fifty thousand publishers always has some dead image
         * URLs in it, and a browser draws its broken-image icon over any image
         * that has a size in CSS — an empty `alt` does not stop it, because the
         * box is still there to paint. So the box is what goes: the image hides
         * itself and the row is left with the empty tile the design already has
         * for a post with no picture at all.
         *
         * Delegated, in the capture phase, because `error` on an image does not
         * bubble — and delegated rather than an `onError` per image so that a
         * listing of fifty rows stays fifty server-rendered `<img>` tags and not
         * fifty hydrated components. It sets a style rather than removing the
         * node, because the node is React's: removing it from under a tree that
         * has not hydrated yet is a mismatch, and an inline style React never set
         * is not something it will patch back. Guarded on the empty alt, so it
         * can only ever act on an image the markup called decorative. With
         * JavaScript off a dead thumbnail shows the browser's icon, which is the
         * same trade the signed-in hint above makes. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "addEventListener('error',function(e){var t=e.target;if(t&&t.tagName==='IMG'&&t.alt==='')t.style.display='none'},true)",
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
                the file lands and the nav below it never jumps — which means
                they have to be rechecked whenever the asset is recut. */}
            <a className="wordmark" href="/">
              {/* One asset for both palettes. The recut wordmark carries its own
                  contrast, so there is no dark variant to swap in and no
                  <picture> wrapper to resolve — which also means nothing here
                  needs rechecking when the theme changes. */}
              <img src="/logo.png" alt="RSS Amplifier" width="1256" height="192" />
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
              <a href="/reels">Reels</a> · <a href="/topics">Topics</a> ·{' '}
              {/* Authors sits here rather than in the nav above, which the
                  comment on that strip explains is already at the height a
                  phone can carry. It is reached from every feed page anyway,
                  which is where somebody wonders who wrote the thing. */}
              <a href="/authors">Authors</a>
            </p>
            <p>
              Machine-readable: <a href="/mcp">MCP server</a> · <a href="/cli">CLI</a> ·{' '}
              <a href="/api/feeds">JSON API</a> · <a href="/opml">OPML</a> ·{' '}
              <a href="/llms.txt">llms.txt</a> · <a href="/crawlstats">Crawler status</a>
            </p>
            {/* The install command itself, not just a link to it. Somebody who
                scrolled to the bottom of a feed page is exactly the person who
                would rather have the directory in their terminal, and making
                them visit a page to find one line is a step that loses most of
                them. */}
            <p className="footer-install">
              <span>Install the CLI:</span>{' '}
              {/* One interpolated string rather than three children: React
                  separates adjacent text nodes with comment markers, and a
                  command people are meant to select and copy should be one
                  text node. */}
              <code>{`curl -fsSL ${siteUrl()}/install.sh | sh`}</code>
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
