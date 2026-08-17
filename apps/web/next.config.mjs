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
  // `next start` instead: a larger image, but one that actually starts.
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },

  async rewrites() {
    return [
      // A topic, as a file extension on the topic's own URL:
      // /topics/physics.rss, .atom, .json, .m3u, .pls — and .xml, because that
      // is what half the web calls an RSS feed.
      //
      // A rewrite rather than a route of its own, because Next cannot put a
      // page.jsx and a route.js in the same segment and /topics/[keyword] is
      // already the page. The extension is stripped here and handed to the
      // handler as a segment, so the reader sees the pretty URL and the
      // handler sees a normal dynamic route.
      //
      // The extension list is duplicated from SYNDICATION_FORMATS in
      // @rssamplifier/feed and cannot import it: next.config is evaluated
      // before the workspace is resolvable. Adding a format means editing both,
      // and the syndication test asserts the two lists agree.
      {
        source: '/topics/:slug.:format(rss|atom|json|xml|m3u|pls)',
        destination: '/api/topics/:slug/feed/:format',
      },
    ];
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
