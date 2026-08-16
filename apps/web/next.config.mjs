/** @type {import('next').NextConfig} */
const nextConfig = {
  // Railway runs this in Docker; standalone keeps the runtime image small.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
};

export default nextConfig;
