import { randomUUID } from 'node:crypto';

import { createClient } from '@libsql/client';

/**
 * Open a Turso/libSQL connection.
 *
 * Env is read through a non-literal property access: Next inlines
 * `process.env.FOO` at build time, which would bake a build-time value into the
 * Docker image and ignore whatever Railway injects at runtime.
 *
 * A `file:` URL needs no auth token, which is what makes local development and
 * the test suite work without a Turso account.
 *
 * @param {{ url?: string, authToken?: string }} [opts]
 * @returns {import('@libsql/client').Client}
 */
export function connect(opts = {}) {
  const env = process.env;
  const url = opts.url ?? env['TURSO_DATABASE_URL'];
  const authToken = opts.authToken ?? env['TURSO_AUTH_TOKEN'];

  if (!url) throw new Error('TURSO_DATABASE_URL must be set');

  return createClient(
    url.startsWith('file:') ? { url } : { url, authToken },
  );
}

/**
 * Application-generated primary key.
 *
 * SQLite has no gen_random_uuid(); generating ids in the app also means an
 * insert knows its own id without a round trip.
 *
 * @returns {string}
 */
export function newId() {
  return randomUUID();
}

/**
 * Current time as ISO-8601, the storage format for every timestamp here.
 *
 * @param {number} [offsetMs] milliseconds to add
 * @returns {string}
 */
export function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}
