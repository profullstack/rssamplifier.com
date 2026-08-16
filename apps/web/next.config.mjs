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
