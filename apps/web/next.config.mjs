/** @type {import('next').NextConfig} */
const nextConfig = {
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

      // The same, for one category of a topic: /topics/physics/podcasts.rss.
      //
      // The group is a path segment in the destination and not `?group=`, which
      // is what this was written as first and what does not work: a rewrite's
      // destination query string never reaches an App Router route handler,
      // because `req.url` there is the URL the client asked for rather than the
      // one the rewrite produced. The parameter arrives as nothing and every
      // sub-group feed quietly serves the whole topic — a failure with no error
      // in it, which is the kind worth a comment.
      //
      // Listed after the one-segment rule for readability only; the two cannot
      // both match, because a rewrite parameter never spans a slash.
      {
        source: '/topics/:slug/:group.:format(rss|atom|json|xml|m3u|pls)',
        destination: '/api/topics/:slug/:group/feed/:format',
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
};

export default nextConfig;
