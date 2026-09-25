import { connect } from '@rssamplifier/db';

/** @type {import('@rssamplifier/db/src/pg.js').PgClient | null} */
let client = null;

/**
 * Shared Postgres pool.
 *
 * Cached across requests: the database is over the network, so opening a fresh
 * pool per request would add a connection handshake to every page load.
 *
 * @returns {import('@rssamplifier/db/src/pg.js').PgClient}
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
