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
              <Script data-site="98aa7ae4-f205-4cf3-8c0f-40182ea3638e" src="https://crawlproof.com/stats.js" strategy="afterInteractive" />
              <div data-cp-ad="" data-slot="2768fe0d-c51c-4629-8d86-0efba3d9ec1f" data-format="banner_300x250" />
        <div data-cp-ad="" data-slot="2768fe0d-c51c-4629-8d86-0efba3d9ec1f" data-format="banner_728x90" />
        <div data-cp-ad="" data-slot="2768fe0d-c51c-4629-8d86-0efba3d9ec1f" data-format="banner_320x50" />
        <div data-cp-ad="" data-slot="2768fe0d-c51c-4629-8d86-0efba3d9ec1f" data-format="text_link" />
        <Script src="https://crawlproof.com/ad.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
