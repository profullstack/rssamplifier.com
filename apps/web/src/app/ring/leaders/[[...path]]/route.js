import { ringLeaderboard } from '../../../../lib/ringLeaderboard.js';

/**
 * /ring/leaders, and everything under it, is the house leaderboard module
 * (@profullstack/leaderboard) over the ring event log: the page, the JSON
 * and RSS of each board, a share card per player, the embeddable widget.
 */
export const dynamic = 'force-dynamic';

/**
 * The leaderboard package serves standalone HTML so it can also power embeds.
 * Route handlers bypass Next's root layout, though, which left the public pages
 * without RSSAmp's wordmark and navigation. Add the same site frame to
 * HTML responses while leaving the JSON, RSS and embed endpoints untouched.
 */
const SITE_FRAME = `
<a class="leaderboard-skip" href="#main">Skip to content</a>
<header class="leaderboard-header">
  <div class="leaderboard-header-inner">
    <a class="leaderboard-wordmark" href="/">
      <img src="/logo.png" alt="RSSAmp" width="1256" height="192">
    </a>
    <nav aria-label="Primary">
      <a href="/blogs">Blogs</a>
      <a href="/news">News</a>
      <a href="/podcasts">Podcasts</a>
      <a href="/ring">Ring</a>
      <a href="/search">Search</a>
      <details class="leaderboard-more">
        <summary>More</summary>
        <div>
          <a href="/music">Music</a>
          <a href="/videos">Videos</a>
          <a href="/topics">Topics</a>
          <a href="/discover">Discover</a>
          <a href="/submit">Submit a feed</a>
          <a href="/about">About</a>
          <a href="/signup">Sign up</a>
        </div>
      </details>
    </nav>
  </div>
</header>`;

const SITE_FRAME_CSS = `
html { color-scheme: light dark; background: #fbfaf8; }
body { min-height: 100vh; display: flex; flex-direction: column; background: #fbfaf8 !important; color: #24221f !important; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; }
.leaderboard-skip { position: absolute; left: -9999px; top: 0; z-index: 100; padding: .6rem 1rem; background: #fff; color: #24221f; }
.leaderboard-skip:focus { left: 0; }
.leaderboard-header { width: 100%; box-sizing: border-box; padding: 1rem 1.25rem; margin: 0 0 1.5rem; border-bottom: 1px solid #e5e2dc; }
.leaderboard-header-inner { max-width: 68rem; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 1.25rem; flex-wrap: wrap; }
.leaderboard-wordmark { display: flex; align-items: center; }
.leaderboard-wordmark img { display: block; height: 2rem; width: auto; }
.leaderboard-header nav { display: flex; align-items: center; justify-content: flex-end; gap: .7rem 1.1rem; flex-wrap: wrap; width: auto; padding: 0; font-size: .92rem; }
.leaderboard-header nav a, .leaderboard-more summary { color: #55514b; text-decoration: none; cursor: pointer; }
.leaderboard-header nav a:hover, .leaderboard-more summary:hover { color: #171614; text-decoration: underline; text-decoration-color: #d66b34; text-underline-offset: 4px; }
.leaderboard-more { position: relative; }
.leaderboard-more summary { list-style: none; }
.leaderboard-more summary::-webkit-details-marker { display: none; }
.leaderboard-more:not([open]) > div { display: none; }
.leaderboard-more[open] > div { position: absolute; z-index: 10; top: 1.5rem; right: 0; min-width: 10rem; display: grid; gap: .65rem; padding: .85rem 1rem; background: #fff; border: 1px solid #e5e2dc; border-radius: .5rem; box-shadow: 0 8px 24px #24221f1a; }
body > main { flex: 1 0 auto; box-sizing: border-box; width: 100%; }
body > main .muted { color: #69655f !important; }
body > main a { color: #155c9a; }
body > main li { border-color: #e5e2dc !important; }
.leaderboard-footer { width: 100%; box-sizing: border-box; margin-top: 3rem; padding: 1.25rem; border-top: 1px solid #e5e2dc; color: #69655f; font-size: .86rem; }
.leaderboard-footer-inner { max-width: 68rem; margin: 0 auto; display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; }
.leaderboard-footer a { color: inherit; }
@media (max-width: 48rem) { .leaderboard-header-inner { align-items: flex-start; } .leaderboard-header nav { justify-content: flex-start; } }
@media (prefers-color-scheme: dark) {
  html { background: #12110f; }
  body { background: #12110f !important; color: #f4f2ed !important; }
  .leaderboard-header, .leaderboard-footer { border-color: #34312c; }
  .leaderboard-header nav a, .leaderboard-more summary { color: #c1bbb1; }
  .leaderboard-header nav a:hover, .leaderboard-more summary:hover { color: #fff; }
  .leaderboard-more[open] > div { background: #1d1b18; border-color: #403c35; box-shadow: 0 8px 24px #0008; }
  body > main .muted { color: #aaa399 !important; }
  body > main a { color: #8bc9ff; }
  body > main li { border-color: #34312c !important; }
  .leaderboard-skip { background: #1d1b18; color: #fff; }
}`;

/** Add the site's normal navigation and footer to a standalone HTML page. */
async function withSiteFrame(response) {
  if (!response || response.status >= 300 || !response.headers.get('content-type')?.includes('text/html')) {
    return response;
  }

  const html = await response.clone().text();
  if (!/<body(?:\s[^>]*)?>/i.test(html) || !/<\/body>/i.test(html)) return response;

  let framedHtml = html.replace(/<\/head>/i, `<style>${SITE_FRAME_CSS}</style></head>`);
  framedHtml = framedHtml.replace(/<body(\s[^>]*)?>/i, (bodyTag) => `${bodyTag}${SITE_FRAME}`);
  framedHtml = framedHtml.replace(/<main\b(?![^>]*\bid=)([^>]*)>/i, '<main id="main"$1>');
  framedHtml = framedHtml.replace(/<\/body>/i, `<footer class="leaderboard-footer"><div class="leaderboard-footer-inner"><strong>RSSAmp</strong><a href="/mcp">MCP</a><a href="/cli">CLI</a><a href="/api/feeds">JSON API</a><a href="/opml">OPML</a><a href="/about">About</a><a href="/privacy">Privacy</a></div></footer></body>`);

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('etag');
  return new Response(framedHtml, { status: response.status, statusText: response.statusText, headers });
}

/** @param {Request} request */
export async function GET(request) {
  const response = (await ringLeaderboard().handle(request)) ?? new Response('Not found', { status: 404 });
  return withSiteFrame(response);
}

export const HEAD = GET;
