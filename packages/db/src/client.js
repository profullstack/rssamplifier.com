import { randomUUID } from 'node:crypto';

import { createPgClient } from './pg.js';
import { createWriteFolder } from './writeFolder.js';
import { queueWrites } from './writeQueue.js';

/**
 * Open the database: PostgreSQL, through the libSQL-shaped client in ./pg.js.
 *
 * Env is read through a non-literal property access: Next inlines
 * `process.env.FOO` at build time, which would bake a build-time value into the
 * Docker image and ignore whatever the host injects at runtime.
 *
 * `DATABASE_URL` is a postgres:// URL. `sslmode=require` in it asks for TLS
 * without verifying the certificate, which is what the self-signed cert on the
 * box needs. The tests do not call this directly: `connectTest()` in
 * ./testdb.js makes a throwaway database per test file and hands back one of
 * these.
 *
 * `timeoutMs` is the per-statement deadline for this connection alone
 * (Postgres `statement_timeout`). The default is right for anything serving a
 * page, and wrong for the one background job that recomputes the category
 * breakdown over half a million feeds; see `warmStatsCache` in ./statsWarmer.js.
 *
 * @param {{ url?: string, redisUrl?: string, queue?: boolean, timeoutMs?: number, max?: number }} [opts]
 * @returns {import('./pg.js').PgClient}
 */
export function connect(opts = {}) {
  const env = process.env;
  const url = opts.url ?? env['DATABASE_URL'];

  if (!url) throw new Error('DATABASE_URL must be set (postgres://...)');
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(`DATABASE_URL must be a postgres:// URL, got ${url.split(':')[0]}:`);
  }

  const client = createPgClient({
    url,
    max: opts.max ?? poolSize(),
    statementTimeoutMs: opts.timeoutMs ?? requestTimeoutMs(),
  });

  // The write queue existed for SQLite's single writer: Turso livelocked when
  // several crawl workers opened transactions at once (see serializeWrites
  // below and writeQueue.js). Postgres has row locks, so writes go straight to
  // the pool. WRITE_QUEUE=1 puts the Redis path back for a deployment that
  // wants one writer anyway; it is off unless asked for.
  const redis = opts.redisUrl ?? env['REDIS_URL'];
  const enabled = ['1', 'true'].includes(String(env['WRITE_QUEUE'] ?? '0').toLowerCase());

  const chosen = writePath({ url, redis, enabled, queue: opts.queue });
  announceWritePath(chosen);

  if (chosen.path === 'redis') return queueWrites(client, { url: String(redis) });

  return client;
}

/**
 * Connections per process. The poller runs six crawl workers plus the
 * housekeeping timers; the web app serves requests. Ten covers both without
 * letting a dozen processes exhaust the cluster's 300.
 */
function poolSize() {
  const raw = Number(process.env['DB_POOL_MAX']);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
}

/**
 * Which write path these settings select, and why.
 *
 * Separated from `connect` so it can be asserted without opening a database.
 * The decision is the part worth testing; the client it returns is not.
 *
 * @param {{ url: string, redis?: string, enabled: boolean, queue?: boolean }} settings
 * @returns {{ path: 'redis'|'direct', why: string }}
 */
export function writePath({ url, redis, enabled, queue }) {
  if (queue === false) return { path: 'direct', why: 'this caller drains the queue' };
  if (String(url).startsWith('file:')) return { path: 'direct', why: 'local file database' };
  if (!enabled) return { path: 'direct', why: 'WRITE_QUEUE is off; Postgres takes concurrent writers' };
  if (!redis) return { path: 'direct', why: 'REDIS_URL is not set' };
  return { path: 'redis', why: 'one writer per cluster' };
}

/** Paths already announced by this process, so a per-request `connect()` says it once. */
const announced = new Set();

/**
 * Say which write path this process took, once.
 *
 * The fallback to `serializeWrites` is deliberate and it is also silent, and
 * the two together are a trap. `REDIS_URL` was never set on either production
 * service, so every write went through the in-process queue while the Redis
 * queue and the folding built for it sat dormant. Nothing was broken and
 * nothing was logged, so "we have a write queue" and "the write queue is
 * running" looked identical from outside until somebody read the environment.
 *
 * A line at boot is the whole fix. It names the reason rather than only the
 * outcome, which is the difference between a degradation that was chosen and
 * one that was inherited.
 *
 * @param {{ path: string, why: string }} chosen
 */
function announceWritePath(chosen) {
  if (announced.has(chosen.path)) return;
  announced.add(chosen.path);
  console.log(`[db] write path: ${chosen.path} (${chosen.why})`);
}

/**
 * How long any single request to the database may take before it is abandoned.
 *
 * The default is undici's, which is **five minutes**, and five minutes is not a
 * timeout — it is a promise that one wedged request will hold a crawl worker
 * for the rest of the tick. Measured after write serialisation landed: per-feed
 * p50 was 5.3 seconds while p90 was 301 seconds, and the p90 is entirely this
 * ceiling. Twelve ticks an hour of twenty-five feeds each should have taken
 * forty-five seconds a tick and took five minutes, because a handful of
 * stragglers each ate a worker for three hundred seconds.
 *
 * Thirty seconds is deliberately generous rather than tight. With writes
 * serialised in-process a real transaction commits in one to two seconds, so
 * anything still outstanding at thirty has not been queued, it has been lost —
 * and the feed is better retried on its own schedule than waited on.
 *
 * @returns {number} milliseconds
 */
function requestTimeoutMs() {
  const raw = Number(process.env['TURSO_REQUEST_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/**
 * `fetch` with a deadline, for libSQL to make its requests through.
 *
 * An AbortSignal rather than a shorter undici setting, because the timeout has
 * to apply to the whole request — headers *and* body — and it has to be one
 * this code owns rather than one the runtime picks.
 *
 * A caller's own signal is respected as well as the deadline: whichever fires
 * first wins, so this cannot quietly extend the life of a request something
 * else has already given up on.
 *
 * @param {number} ms
 * @returns {typeof fetch}
 */
export function withTimeout(ms) {
  return (input, init = {}) => {
    const deadline = AbortSignal.timeout(ms);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return fetch(input, { ...init, signal });
  };
}

/**
 * One write transaction at a time, per process, with queued callers folded
 * into the next transaction.
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
 * across the network where losing costs 300 seconds.
 *
 * Queueing alone fixed the livelock and exposed the next limit: every first
 * crawl still opened one remote transaction. With six crawl workers and a
 * throttled write path, a 600-feed pass took 37 minutes even though 445 hosts
 * were available. The five workers waiting while the first transaction runs
 * have already prepared all of their statements, so the next transaction
 * folds those callers together. SQLite was going to serialize them anyway;
 * this pays for the remote transaction once instead of once per feed.
 *
 * Results are sliced back to the caller that supplied each statement range, so
 * this is invisible above the client. A statement-local SQLite error is retried
 * caller by caller to identify the bad write without wedging its neighbours. A
 * transport or timeout failure is not retried here: repeating a whole failed
 * remote transaction as several more remote transactions would amplify the
 * outage.
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
 * @param {{ maxStatements?: number }} [opts]
 * @returns {import('@libsql/client').Client}
 */
export function serializeWrites(client, opts = {}) {
  const configured = Number(opts.maxStatements ?? process.env['TURSO_WRITE_GROUP_STATEMENTS']);
  // One is the safe production default. A five-crawl group was canaried against
  // the throttled primary and exceeded the 30-second request deadline; grouping
  // remains available for a database whose transaction path has been measured.
  const maxStatements = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1;
  const original = client.batch.bind(client);

  // The folding itself lives in writeFolder.js, because the Redis queue needs
  // exactly the same thing and having two copies of it is how they drift.
  const enqueue = createWriteFolder({
    run: (statements) => original(statements, 'write'),
    maxStatements,
  });

  // Overriding the single method that opens a transaction touches nothing else.
  client.batch = (statements, mode) =>
    // Only transactions that can take the write lock. A read batch is several
    // selects and holds nothing.
    mode === 'read' ? original(statements, mode) : enqueue(statements);

  // `transaction()` is deliberately left alone. It hands the caller an open
  // transaction to hold across awaits, which this queue cannot bound -- a lock
  // held while the caller does anything else is the problem, not the solution.

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
