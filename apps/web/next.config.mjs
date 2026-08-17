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
          source: '/topics/:slug.:format(rss|atom|json|xml|m3u|pls)',
          destination: '/api/topics/:slug/feed/:format',
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
};

export default nextConfig;
