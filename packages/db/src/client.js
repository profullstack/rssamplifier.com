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
    createClient(
      url.startsWith('file:') ? { url } : { url, authToken, fetch: withTimeout(requestTimeoutMs()) },
    ),
  );
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
  const maxStatements = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1000;
  const original = client.batch.bind(client);

  /** @type {Array<{ statements: unknown[], resolve: (value: unknown) => void, reject: (reason: unknown) => void }>} */
  const waiting = [];
  let draining = false;

  /**
   * Put one caller behind the transaction currently in flight.
   *
   * The first caller starts immediately. Everyone arriving while it awaits the
   * remote database accumulates in `waiting` and is folded together on the next
   * turn, up to a statement ceiling that keeps one transaction bounded.
   *
   * @param {unknown[]} statements
   * @returns {Promise<unknown>}
   */
  const enqueue = (statements) =>
    new Promise((resolve, reject) => {
      waiting.push({ statements: Array.from(statements ?? []), resolve, reject });
      void drain();
    });

  async function drain() {
    if (draining) return;
    draining = true;

    try {
      while (waiting.length > 0) {
        const group = [];
        let statementCount = 0;

        while (waiting.length > 0) {
          const next = waiting[0];
          const size = next.statements.length;
          if (group.length > 0 && statementCount + size > maxStatements) break;
          group.push(waiting.shift());
          statementCount += size;
        }

        const statements = group.flatMap((entry) => entry.statements);

        try {
          const results = await original(statements, 'write');
          settleGroup(group, Array.from(results ?? []));
        } catch (err) {
          if (group.length > 1 && isStatementError(err)) {
            // The transaction was rejected because one statement is bad. Run
            // each caller on its own to preserve failure isolation and ordering.
            for (const entry of group) {
              try {
                entry.resolve(await original(entry.statements, 'write'));
              } catch (singleErr) {
                entry.reject(singleErr);
              }
            }
          } else {
            for (const entry of group) entry.reject(err);
          }
        }
      }
    } finally {
      draining = false;
      // A caller can arrive after the while condition and before the flag is
      // cleared. Do not leave it asleep until an unrelated later write arrives.
      if (waiting.length > 0) void drain();
    }
  }

  // The one method replaced, on the instance, rather than the whole client
  // wrapped in a Proxy. A Proxy was the first attempt and it broke 154 tests:
  // libSQL's client keeps private class fields, and reading one through a
  // Proxy receiver throws, so every call that was merely passing through died.
  // Overriding the single method that opens a transaction touches nothing else.
  client.batch = (statements, mode) =>
    // Only transactions that can take the write lock. A read batch is several
    // selects and has no business waiting behind a crawl.
    mode === 'read' ? original(statements, mode) : enqueue(statements);

  // `transaction()` is deliberately left alone. It hands the caller an open
  // transaction to hold across awaits, which this queue cannot bound -- a lock
  // acquired here and released who-knows-when is worse than no lock. Nothing in
  // this codebase calls it; if something starts to, it should be a deliberate
  // decision rather than a silent hole in the serialisation.

  return client;
}

/**
 * Hand each caller the result rows belonging to its own statements.
 *
 * libSQL returns one ResultSet per statement, in order. A caller above this
 * layer must never learn that its transaction shared a round trip.
 *
 * @param {Array<{ statements: unknown[], resolve: (value: unknown) => void }>} group
 * @param {unknown[]} results
 */
function settleGroup(group, results) {
  let offset = 0;
  for (const entry of group) {
    const end = offset + entry.statements.length;
    entry.resolve(results.slice(offset, end));
    offset = end;
  }
}

/**
 * Whether retrying a failed combined transaction can isolate one bad caller.
 *
 * Network failures and deadlines affect the database as a whole and must not be
 * multiplied into N retries. SQLite statement/constraint errors are local to
 * the SQL or data and are worth splitting once so neighbouring feeds survive.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isStatementError(err) {
  const text = String(err?.message ?? err);
  return /SQLITE_(?:CONSTRAINT|ERROR|MISMATCH|RANGE)|constraint failed|syntax error|no such (?:table|column)/i.test(
    text,
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
