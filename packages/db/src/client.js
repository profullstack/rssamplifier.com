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

  return serializeWrites(
    createClient(url.startsWith('file:') ? { url } : { url, authToken }),
  );
}

/**
 * One write transaction at a time, per process.
 *
 * SQLite permits exactly one writer. That is not a limitation to be tuned
 * around, it is the storage engine, and the crawler had been ignoring it: four
 * crawl workers plus the card, cluster, author and alert passes each issued
 * their own `db.batch(..., 'write')` whenever they felt like it, so a dozen
 * explicit transactions contended for a lock only one of them could hold.
 *
 * The result was not slowness, it was a livelock. Measured against production:
 *
 *   db.execute(update ...)            389ms      -- autocommit, no transaction
 *   db.batch([same update], 'write')  302s       -- FAILED, header timeout
 *   db.batch([20 updates], 'deferred') 123s      -- FAILED, SQLITE_BUSY
 *
 * Identical work; the only difference is the explicit transaction. Each waiter
 * sat on the lock queue until the client's 300-second timeout, gave up, and
 * retried -- so nothing committed and crawl throughput was **exactly zero**
 * while single-statement writes went through in under half a second. The
 * clinching evidence is that with the poller stopped, those same batch-write
 * transactions committed at ~2,200 rows a minute: the contention was entirely
 * self-inflicted.
 *
 * So writes queue here instead of at the database. A caller waits its turn in
 * this process, where waiting is free and ordered, rather than racing a lock
 * across the network where losing costs 300 seconds. Throughput is unchanged --
 * the database could only ever run one writer anyway -- but the time formerly
 * spent timing out is now spent committing.
 *
 * Reads are untouched. They do not take the write lock, they measured fine
 * throughout (80-400ms), and putting them behind this queue would serialise a
 * web request behind a crawl.
 *
 * Per process, not per cluster. Two processes still contend, and the poller and
 * the web service are two processes -- but the web service writes rarely and
 * briefly, so the population that was livelocking is the one this covers.
 *
 * @param {import('@libsql/client').Client} client
 * @returns {import('@libsql/client').Client}
 */
export function serializeWrites(client) {
  /** The tail of the queue: every write chains onto the previous one. */
  let tail = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  const enqueue = (run) => {
    // Chained off a settled-either-way tail, so one failed write does not
    // wedge every write after it -- which would turn a transient error into
    // the outage this exists to prevent.
    const mine = tail.then(run, run);
    tail = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  };

  const original = client.batch.bind(client);

  // The one method replaced, on the instance, rather than the whole client
  // wrapped in a Proxy. A Proxy was the first attempt and it broke 154 tests:
  // libSQL's client keeps private class fields, and reading one through a
  // Proxy receiver throws, so every call that was merely passing through died.
  // Overriding the single method that opens a transaction touches nothing else.
  client.batch = (statements, mode) =>
    // Only transactions that can take the write lock. A read batch is several
    // selects and has no business waiting behind a crawl.
    mode === 'read' ? original(statements, mode) : enqueue(() => original(statements, mode));

  // `transaction()` is deliberately left alone. It hands the caller an open
  // transaction to hold across awaits, which this queue cannot bound -- a lock
  // acquired here and released who-knows-when is worse than no lock. Nothing in
  // this codebase calls it; if something starts to, it should be a deliberate
  // decision rather than a silent hole in the serialisation.

  return client;
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
