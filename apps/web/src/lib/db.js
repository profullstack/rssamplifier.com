import { connect } from '@rssamplifier/db';

/** @type {import('@libsql/client').Client | null} */
let client = null;

/**
 * Shared libSQL connection.
 *
 * Cached across requests: Turso is a network database, so opening a fresh
 * connection per request would add a round trip to every page load.
 *
 * @returns {import('@libsql/client').Client}
 */
export function db() {
  if (!client) client = connect();
  return client;
}

/**
 * Public origin of the site, without a trailing slash.
 *
 * Read through a non-literal property access: Next inlines `process.env.FOO` at
 * build time, which would bake the build-time value into the Docker image and
 * ignore whatever Railway injects at runtime.
 *
 * @returns {string}
 */
export function siteUrl() {
  const env = process.env;
  return (env['SITE_URL'] || 'https://rssamplifier.com').replace(/\/+$/, '');
}
