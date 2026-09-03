/**
 * The site's Content-Security-Policy.
 *
 * Written wide on purpose, because this is a directory of other people's media:
 * a post's audio, video, cover art and embedded player all come from whatever
 * host published them, and there is no allowlist that could name them in
 * advance. So `https:` is the allowlist for media, images and frames, and what
 * the policy actually buys is the two directives that matter for a site with a
 * session cookie: script-src, which stops an injected `<script src>` pointing
 * anywhere but here, and form-action, which stops an injected form posting a
 * login somewhere else.
 *
 * `'unsafe-inline'` on script-src is not an oversight either. The alternative
 * is a per-request nonce, and a nonce has to be generated per response, which
 * opts every page out of static rendering — for a directory whose pages are
 * almost all static, that trades a real speed-up for a partial hardening.
 * React's own hydration payload and the JSON-LD blocks are inline, so the
 * inline allowance is load-bearing either way.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  // An injected form cannot post the session anywhere but back to us.
  "form-action 'self'",
  // Who may frame *us*. The reader frames its own /api/frame, which is
  // same-origin, so 'self' covers the one case the site relies on.
  "frame-ancestors 'self'",
  // Whose pages *we* may frame: the publisher's, via /api/frame, plus the two
  // third-party players in EpisodePlayer (YouTube and PeerTube).
  "frame-src 'self' https:",
  // Cover art and post images, from every host in the directory.
  "img-src 'self' data: blob: https:",
  // Episode audio and video, likewise.
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  // Next injects inline style attributes; there is no nonce-free way around it.
  "style-src 'self' 'unsafe-inline'",
  // crawlproof.com serves the analytics beacon and the ad loader.
  "script-src 'self' 'unsafe-inline' https://crawlproof.com",
  "connect-src 'self' https:",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');

/**
 * Headers that are safe on every response, including the API.
 */
const SECURITY_HEADERS = [
  // Two years, subdomains included. Deliberately no `preload`: the preload list
  // is close to irreversible and its own operator now discourages new entries.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // The legacy half of frame-ancestors, for browsers that still read it.
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  // Send the origin cross-site but never the path. Note this is an origin, not
  // nothing: YouTube authorizes an embed by its Referer and refuses the video
  // outright when it gets none — see the comment in EpisodePlayer.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nothing here asks for a camera, a microphone or a location, so nothing
  // injected into a page should be able to either.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // `X-Powered-By: Next.js` tells a scanner which framework's CVEs to try
  // first, and tells a visitor nothing.
  poweredByHeader: false,

  // Deliberately NOT `output: 'standalone'`.
  //
  // Standalone tracing walks real filesystem paths to decide what to copy. Under
  // pnpm's symlinked store it misses next's own runtime dependency on
  // @swc/helpers, producing a bundle that builds cleanly and then dies with
  // MODULE_NOT_FOUND on first boot. `node-linker=hoisted` did not reliably fix
  // it here either. The Docker image carries real node_modules and runs
  // `server.mjs` — Next's own request handler behind a ceiling on concurrent
  // requests, see src/lib/loadShed.js — instead: a larger image, but one that
  // actually starts.
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },

  async rewrites() {
    return {
      // Checked before the filesystem, which is the only way a path that has a
      // page.jsx can also answer something else.
      beforeFiles: [
        // /mcp is two things at one address: a documentation page in a browser,
        // and the MCP endpoint itself for a client. Next cannot put a page.jsx
        // and a route.js in the same segment, so the request is sorted by what
        // it looks like rather than by where it points.
        //
        // Every test below is something only a client does, and none of them is
        // something a browser following a link does. A request matching none
        // falls through to the page, so the worst case for a misconfigured
        // client is HTML rather than a redirect loop.
        //
        // The endpoint answers at /api/mcp too, alongside the rest of the JSON
        // API. This rewrite is what makes the short URL the one worth writing
        // down.
        //
        // The order is widest-net-last: the first two identify the protocol
        // outright, the third catches a CORS preflight, and the fourth catches
        // anything else posting JSON.
        {
          // Required on every POST in the current revision.
          source: '/mcp',
          has: [{ type: 'header', key: 'mcp-protocol-version' }],
          destination: '/api/mcp',
        },
        {
          // Required of every client since Streamable HTTP was introduced, and
          // sent by no browser navigating to a page.
          source: '/mcp',
          has: [{ type: 'header', key: 'accept', value: '.*text/event-stream.*' }],
          destination: '/api/mcp',
        },
        {
          // A CORS preflight, which exists only as a preflight — a browser-based
          // client sends one before its first POST, and it has to reach a
          // handler that answers with the protocol's own header names or the
          // real request is never sent at all.
          source: '/mcp',
          has: [{ type: 'header', key: 'access-control-request-method' }],
          destination: '/api/mcp',
        },
        {
          // Anything else posting JSON here means the endpoint, not the page.
          // This is the one that saves somebody hand-writing a request and
          // leaving off a header they had no way to know was load-bearing.
          source: '/mcp',
          has: [{ type: 'header', key: 'content-type', value: '.*application/json.*' }],
          destination: '/api/mcp',
        },
      ],

      afterFiles: [
        // A topic, as a file extension on the topic's own URL:
        // /topics/physics.rss, .atom, .json, .m3u, .pls — and .xml, because
        // that is what half the web calls an RSS feed.
        //
        // A rewrite rather than a route of its own, because Next cannot put a
        // page.jsx and a route.js in the same segment and /topics/[keyword] is
        // already the page. The extension is stripped here and handed to the
        // handler as a segment, so the reader sees the pretty URL and the
        // handler sees a normal dynamic route.
        //
        // The extension list is duplicated from SYNDICATION_FORMATS in
        // @rssamplifier/feed and cannot import it: next.config is evaluated
        // before the workspace is resolvable. Adding a format means editing
        // both, and the syndication test asserts the two lists agree.
        {
          source: '/topics/:slug.:format(rss|atom|json|xml|md|m3u|pls)',
          destination: '/api/topics/:slug/feed/:format',
        },

        // The same, for one category of a topic: /topics/physics/podcasts.rss.
        //
        // The group is a path segment in the destination and not `?group=`,
        // which is what this was written as first and what does not work: a
        // rewrite's destination query string never reaches an App Router route
        // handler, because `req.url` there is the URL the client asked for
        // rather than the one the rewrite produced. The parameter arrives as
        // nothing and every sub-group feed quietly serves the whole topic — a
        // failure with no error in it, which is the kind worth a comment.
        //
        // Listed after the one-segment rule for readability only; the two
        // cannot both match, because a rewrite parameter never spans a slash.
        {
          source: '/topics/:slug/:group.:format(rss|atom|json|xml|md|m3u|pls)',
          destination: '/api/topics/:slug/:group/feed/:format',
        },

        // One reader's own river: /following.rss?t=<token>.
        //
        // The token stays in the query rather than becoming a segment, which is
        // the one thing about this rewrite worth knowing: a destination query
        // string never arrives at an App Router handler, but the *caller's* query
        // does, because `req.url` there is the URL the client asked for. So `?t=`
        // survives and a `?t=` written here would not.
        //
        // No playlist formats, unlike the topic rules above — see the handler for
        // why a personal river has no honest `.m3u`.
        {
          source: '/following.:format(rss|atom|json|xml)',
          destination: '/api/following/feed/:format',
        },

        // Everything else that lists things, as a feed of ours.
        //
        // These four rules are ordered, and the order is the whole design: the
        // last of them matches *any* single segment with an extension, because
        // a feed's page is `/:slug` and its feed has to be `/:slug.rss`. So
        // every fixed address that also wants a feed has to be named before it.
        // Anything with a page.jsx or a route.js of its own is already safe —
        // afterFiles runs only when the filesystem did not answer — which is
        // why /sitemap.xml, /skill.md and /llms.txt are not listed here and
        // cannot be shadowed.
        //
        // Markdown is in the format list for the same reason it is in
        // SYNDICATION_FORMATS: an agent handed a URL should not have to parse
        // XML to read a blog. It carries no playlist spellings, and neither do
        // the directory rules — a directory entry has nothing to play.

        // The directory itself: what was added to it, newest first.
        { source: '/feed.:format(rss|atom|json|xml|md)', destination: '/api/directory/feed/:format' },

        // The two social namespaces.
        //
        // No playlist spellings, for the same reason /following has none: a
        // timeline and a subreddit carry no enclosures, so an `.m3u` of one
        // would be an empty file with a confident name.
        //
        // Ordered narrowest-first within each prefix, because `:username` and
        // `:subreddit` match anything: every fixed address under /x has to be
        // named before /x/:username, and /r/u before /r/:subreddit. A rewrite
        // parameter never spans a slash, so the two-segment rules cannot be
        // shadowed by the one-segment ones — but the fixed segments can be, and
        // silently.
        {
          source: '/x/search.:format(rss|atom|json|xml|md)',
          destination: '/api/x/search/feed/:format',
        },
        {
          source: '/x/list/:listId.:format(rss|atom|json|xml|md)',
          destination: '/api/x/list/:listId/feed/:format',
        },
        {
          source: '/x/:username/:mode(replies|media).:format(rss|atom|json|xml|md)',
          destination: '/api/x/:username/:mode/feed/:format',
        },
        {
          source: '/x/:username.:format(rss|atom|json|xml|md)',
          destination: '/api/x/:username/feed/:format',
        },
        {
          source: '/r/u/:username.:format(rss|atom|json|xml|md)',
          destination: '/api/r/u/:username/feed/:format',
        },
        {
          source: '/r/:subreddit.:format(rss|atom|json|xml|md)',
          destination: '/api/r/:subreddit/feed/:format',
        },
        {
          source: '/ig/tag/:tag.:format(rss|atom|json|xml|md)',
          destination: '/api/ig/tag/:tag/feed/:format',
        },
        {
          source: '/ig/:username.:format(rss|atom|json|xml|md)',
          destination: '/api/ig/:username/feed/:format',
        },
        {
          source: '/fb/:page.:format(rss|atom|json|xml|md)',
          destination: '/api/fb/:page/feed/:format',
        },

        // One category of it. The segments are the category pages' own paths,
        // duplicated from CATEGORIES in apps/web/src/lib/categories.js — this
        // file is evaluated before the workspace resolves, so it cannot import
        // them. A test asserts the two lists agree.
        {
          source:
            '/:kind(blogs|news|podcasts|music|videos|comics|lives|reels).:format(rss|atom|json|xml|md)',
          destination: '/api/directory/:kind/feed/:format',
        },

        // A saved search. `?q=` rides along on the caller's own URL — see the
        // /following note above for why a destination query would not.
        { source: '/search.:format(rss|atom|json|xml|md)', destination: '/api/search/feed/:format' },

        // One person, across every feed of theirs the directory knows about.
        {
          source: '/authors/:slug.:format(rss|atom|json|xml|md)',
          destination: '/api/authors/:slug/feed/:format',
        },

        // One feed of the directory — our copy, at our address, so a reader who
        // wants to subscribe to what they are reading does not have to leave to
        // do it. Last, because `:slug` matches anything.
        {
          source: '/:slug.:format(rss|atom|json|xml|md|m3u|pls)',
          destination: '/api/feeds/:slug/feed/:format',
        },
      ],
    };
  },

  async redirects() {
    return [
      // www → apex, permanently, keeping the path and query.
      //
      // Both hostnames are custom domains on the same Railway service, so
      // before this every page answered on two addresses with identical
      // markup — two URLs for one page, which splits whatever authority the
      // page earns and gives crawlers a duplicate to pick between. The apex is
      // the canonical one, so www is the one that moves.
      //
      // Matched on the Host header, which means it costs nothing anywhere else:
      // localhost, the *.up.railway.app domain and any future hostname fall
      // straight through.
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.rssamplifier.com' }],
        destination: 'https://rssamplifier.com/:path*',
        permanent: true,
      },

      // What people type when they are looking for the sign-up page. There is
      // only one, and it is /signup.
      // The crawler status board is at /crawlstats. /crawlstatus is what people
      // type looking for it, including us.
      { source: '/crawlstatus', destination: '/crawlstats', permanent: true },

      { source: '/register', destination: '/signup', permanent: true },
      { source: '/sign-up', destination: '/signup', permanent: true },
      { source: '/sign-in', destination: '/login', permanent: true },
    ];
  },

  async headers() {
    return [
      // The safe ones, everywhere.
      { source: '/:path*', headers: SECURITY_HEADERS },

      // The CSP, everywhere *except* the API.
      //
      // /api/frame answers with a publisher's own page, reassembled and served
      // from this origin, and it already sends a CSP of its own that sandboxes
      // that page. A second CSP header does not replace the first — the browser
      // enforces both, and their intersection is `default-src 'self'` applied to
      // a stranger's markup, which strips the frame of the publisher's images,
      // stylesheets and fonts. So the site policy stops short of /api and lets
      // the route's own, stricter one stand alone.
      {
        source: '/((?!api/).*)',
        headers: [{ key: 'Content-Security-Policy', value: CSP }],
      },
    ];
  },
};

export default nextConfig;
