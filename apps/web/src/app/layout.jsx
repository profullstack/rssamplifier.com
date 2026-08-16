import './globals.css';

import { siteUrl } from '../lib/db.js';
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
 * @param {{ children: React.ReactNode }} props
 */
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>

        <header className="masthead">
          <div className="masthead-inner">
            <a className="wordmark" href="/">
              RSS<span>Amplifier</span>
            </a>
            <nav aria-label="Primary">
              <a href="/submit">Submit</a>
              <a href="/search">Search</a>
              <a href="/opml">OPML</a>
              <a href="/llms.txt">llms.txt</a>
              <a href="/about">About</a>
              {/* Always "Account", never "Sign in" or the reader's address:
                  telling them apart means reading the session cookie here,
                  which would make every page in the site dynamic. /account
                  sends a signed-out visitor to /login, which costs one redirect
                  and keeps the static pages static. */}
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
              Machine-readable: <a href="/api/feeds">JSON API</a> · <a href="/opml">OPML</a> ·{' '}
              <a href="/llms.txt">llms.txt</a>
            </p>
          </div>
        </footer>

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
