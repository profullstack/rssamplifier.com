import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'RSS Amplifier — an open directory of blogs, built for agents';

/**
 * The card every link to this site unfurls into.
 *
 * The site had no og:image at all, so a link posted anywhere — Slack, Mastodon,
 * a search result, an assistant citing the directory — rendered as a bare URL.
 * Drawn here rather than shipped as a PNG so it stays in step with the palette
 * in globals.css instead of being a binary nobody remembers to re-export.
 *
 * Root-level, so every route inherits it; a page with a better card of its own
 * can still override it by placing its own opengraph-image beside it.
 *
 * The type is the renderer's own sans rather than the site's serif: loading a
 * face here means shipping a font binary and fetching it on every miss, which
 * is a lot of machinery for the wordmark on a card, and the palette is what
 * carries the resemblance anyway.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          background: '#fbfaf8',
          color: '#16150f',
          padding: '80px',
        }}
      >
        <div style={{ display: 'flex', fontSize: 40, color: '#b4552d', letterSpacing: -1 }}>
          RSS Amplifier
        </div>
        <div style={{ display: 'flex', fontSize: 78, lineHeight: 1.1, marginTop: 24 }}>
          An open directory of blogs, built for agents.
        </div>
        <div style={{ display: 'flex', fontSize: 30, color: '#6b6862', marginTop: 32 }}>
          JSON · OPML · RSS · MCP — no account, no paywall
        </div>
      </div>
    ),
    size,
  );
}
