import { normalizeUrl, probePage, readableArticle, reframePage } from '@rssamplifier/feed';
import { withPageSlot } from '../../../lib/pageGate.js';

import { siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * The document the reader's frame actually loads.
 *
 * Framing the publisher's URL directly is what the reader used to do, and it
 * breaks on the second click: every link inside the frame loads into the
 * frame, and a link to anywhere with X-Frame-Options or a frame-ancestors
 * policy turns the reading surface into "refused to connect". The embedder is
 * told nothing — a cross-origin frame reports neither its location nor a
 * failed load — so there is no fallback to trigger and no way to even notice.
 *
 * Serving the page from here is what makes its links ours to fix. The markup
 * takes a detour through this route; the `<base>` it comes back with means
 * every stylesheet, image, font and script still loads from the publisher's
 * own server, so what renders is still their page.
 *
 * Three things it deliberately is not:
 *
 * A way around a refusal. Only pages that already published "anyone may frame
 * me" are served as themselves. A site that refuses is refusing, and gets the
 * same answer as everywhere else in the reader: read the page, render the
 * article, link to the original. Routing a "no" through our origin so it looks
 * like a "yes" is the one thing this must not do.
 *
 * An open proxy. It fetches with the SSRF guard every other outbound fetch in
 * this codebase uses — no private, loopback, link-local or metadata addresses,
 * on the first request or after a redirect — under a byte cap and a timeout.
 *
 * A hole in our origin. The response carries `Content-Security-Policy:
 * sandbox`, which applies however the document is loaded, so somebody else's
 * markup can never run with rssamplifier.com's origin — not in the frame, and
 * not by pasting this URL into the address bar.
 */

/** What the frame is allowed to do, stated on the response so it holds everywhere. */
const SANDBOX =
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms; ' +
  "frame-ancestors 'self'";

/**
 * @param {Request} req
 * @returns {Promise<Response>}
 */
export async function GET(req) {
  const asked = new URL(req.url).searchParams.get('u') ?? '';
  const target = normalizeUrl(asked);

  if (!target) return card({ url: asked, message: 'That is not an address this can open.' });

  const site = siteUrl();
  const self = `${site}/api/frame?u=${encodeURIComponent(asked)}`;
  const through = (url) => `${site}/api/frame?u=${encodeURIComponent(url)}`;

  // The same bound the reader is under, and this route needs it more: it runs
  // the identical fetch-and-parse with no extract cache in front of it, so
  // every call reaches an origin. Reasoning in lib/pageGate.js.
  return withPageSlot(
    () => openPage({ target, site, self, through }),
    () =>
      card({
        url: target,
        message: 'The reader is busy right now. Try this again in a moment.',
      }),
  );
}

/**
 * Open one page, having been given room to.
 *
 * Split out of `GET` so the gate has a unit to wrap; the body is unchanged.
 *
 * @param {{ target: string, site: string, self: string, through: (url: string) => string }} ctx
 * @returns {Promise<Response>}
 */
async function openPage({ target, site, self, through }) {
  const probe = await probePage(target, { origin: site, wantHtml: 'always' });
  const landed = probe.url ?? target;

  // The page said anyone may frame it, and we have its markup: hand it back
  // with its links pointing at somewhere that will open.
  if (probe.frameable && probe.html) {
    return html(reframePage(probe.html, { url: landed, self, through, origin: site }));
  }

  // Frameable, but not a page — a PDF, an image, a download. Nothing to
  // rewrite, and the publisher serves it better than we would.
  if (probe.frameable && !probe.html && probe.status && probe.status < 400) {
    return Response.redirect(landed, 302);
  }

  // A refusal, and the article is in the response that refused us. This is the
  // reader's existing answer to X-Frame-Options, applied one link deeper than
  // it used to reach.
  const article = probe.html ? readableArticle(probe.html, landed) : null;
  if (article) {
    return html(
      reframePage(read(article, landed), { url: landed, self, through, origin: site }),
    );
  }

  return card({ url: landed, message: explain(probe.reason) });
}

/**
 * Why a page could not be opened, in words a reader can act on.
 *
 * Deliberately not the reason the *frame* was refused: by the time this runs,
 * the refusal has stopped being the interesting part — we could not read the
 * page either, and that is what the reader is looking at.
 *
 * @param {string} reason
 * @returns {string}
 */
function explain(reason) {
  if (reason === 'timeout') return 'This page took too long to answer.';
  // One reason covers two things — an address that does not resolve, and one
  // that resolves somewhere private we refuse to fetch — and a reader cannot
  // act on the difference. Both mean the link goes nowhere reachable.
  if (reason === 'blocked-host') return 'That address does not lead anywhere we can reach.';
  if (reason === 'fetch-failed') return 'This page could not be reached.';
  if (reason.startsWith('http-')) return 'This page did not load.';
  return 'This page cannot be shown here.';
}

/**
 * The article, read off a page that would not be framed.
 *
 * Its links already leave for a new tab — sanitizeHtml puts `target="_blank"`
 * on every one of them, the same as everywhere else the directory renders
 * somebody's prose — so the reader keeps their place here either way.
 *
 * @param {{ html: string, byline: string|null, siteName: string|null }} article
 * @param {string} url
 * @returns {string}
 */
function read(article, url) {
  const source = article.siteName ?? hostOf(url);
  const credit = article.byline ? `${escapeText(article.byline)} · ` : '';

  // The same label the reader page puts over a paid post's free preview, so a
  // cut piece reads as cut one link deeper too rather than as an ending.
  const preview = article.preview
    ? `<p class="meta">This is the free preview. The rest is for subscribers on ${escapeText(source)}.</p>`
    : '';
  const action = article.preview ? 'Continue reading' : 'Read the original';

  return shell(`
    <p class="meta">${credit}${escapeText(source)}</p>
    ${preview}
    <article>${article.html}</article>
    <p class="meta">
      <a href="${escapeAttr(url)}" target="_blank" rel="noopener">${action} on ${escapeText(hostOf(url))} ↗</a>
    </p>
  `);
}

/**
 * The honest rectangle, for a page that is neither frameable nor readable.
 *
 * Still better than what it replaces. "Refused to connect" is the browser
 * telling the reader about a policy they did not set and cannot do anything
 * about; this tells them where they were going and offers to take them.
 *
 * @param {{ url: string, message: string }} what
 * @returns {Response}
 */
function card({ url, message }) {
  const link = normalizeUrl(url);

  return html(
    shell(`
      <div class="card">
        <p>${escapeText(message)}</p>
        ${
          link
            ? `<p><a class="button" href="${escapeAttr(link)}" target="_blank" rel="noopener">Open ${escapeText(hostOf(link))} ↗</a></p>`
            : ''
        }
      </div>
    `),
  );
}

/**
 * A page in the reader's own clothes.
 *
 * Inline, because this document is served into a sandbox with no origin and a
 * stylesheet of ours would be one more request to make it look like the page
 * it is standing in for. It follows the reader's light and dark rather than
 * the publisher's, since none of the publisher's design survived to here.
 *
 * @param {string} body
 * @returns {string}
 */
function shell(body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --ink: #16161a; --paper: #fdfdfb; --muted: #6b6b73; --line: #e3e3dd; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e8e8e6; --paper: #16161a; --muted: #9a9aa2; --line: #2c2c33; }
  }
  body {
    margin: 0; padding: 2rem 1.25rem; background: var(--paper); color: var(--ink);
    font: 1.05rem/1.65 ui-serif, Georgia, "Times New Roman", serif;
  }
  main { max-width: 42rem; margin: 0 auto; }
  .meta { color: var(--muted); font-family: ui-sans-serif, system-ui, sans-serif; font-size: .85rem; }
  .card { border: 1px solid var(--line); border-radius: .5rem; padding: 1.5rem; text-align: center; }
  .button {
    display: inline-block; padding: .5rem 1rem; border: 1px solid var(--line);
    border-radius: .375rem; text-decoration: none; color: inherit;
  }
  a { color: inherit; }
  img, video, figure, table { max-width: 100%; height: auto; }
  pre { overflow-x: auto; }
  h1, h2, h3 { line-height: 1.25; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/**
 * @param {string} body
 * @returns {Response}
 */
function html(body) {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': SANDBOX,
      'x-content-type-options': 'nosniff',
      // The reader is already noindex for the same reason: this must never
      // compete in search with the page it is showing.
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer-when-downgrade',
      // Long enough that walking back and forth through a blog does not ask
      // the publisher's server again, short enough to not be a cache of their
      // site. Private, because it is one reader's reading, not a shared copy.
      'cache-control': 'private, max-age=300',
    },
  });
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

/**
 * @param {string} value
 * @returns {string}
 */
function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}
