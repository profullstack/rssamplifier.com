import './globals.css';

import { siteUrl } from '../lib/db.js';

export const metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: 'RSS Amplifier — an open directory of blogs, built for agents',
    template: '%s · RSS Amplifier',
  },
  description:
    'Submit a URL, a list of URLs or an OPML file. Every blog gets its own page, its summaries stay readable, and the whole directory is available as JSON, OPML and plain text for AI agents.',
  alternates: {
    types: {
      'application/rss+xml': '/opml',
    },
  },
  openGraph: {
    type: 'website',
    siteName: 'RSS Amplifier',
  },
};

/**
 * @param {{ children: React.ReactNode }} props
 */
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <div className="masthead-inner">
            <a className="wordmark" href="/">
              RSS<span>Amplifier</span>
            </a>
            <nav>
              <a href="/submit">Submit</a>
              <a href="/search">Search</a>
              <a href="/opml">OPML</a>
              <a href="/llms.txt">llms.txt</a>
              <a href="/about">About</a>
            </nav>
          </div>
        </header>

        <main className="wrap">{children}</main>

        <footer className="site">
          <div className="wrap">
            <p>
              An open, agent-friendly directory of independent blogs. Anyone can add a feed; no
              account needed. Built by{' '}
              <a href="https://profullstack.com">Profullstack, Inc.</a>
            </p>
            <p>
              Machine-readable: <a href="/api/feeds">JSON API</a> · <a href="/opml">OPML</a> ·{' '}
              <a href="/llms.txt">llms.txt</a>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
