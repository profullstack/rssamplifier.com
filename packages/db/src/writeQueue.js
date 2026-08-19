import { Queue, QueueEvents, Worker } from 'bullmq';

/**
 * The write path, moved out of the process and into Redis.
 *
 * `serializeWrites` in ./client.js solved the livelock that was costing the
 * crawler everything: SQLite permits one writer, a dozen concurrent explicit
 * transactions each waited out a 300-second client timeout, and nothing ever
 * committed. Queueing them in-process fixed it, and its own comment names the
 * hole it left — *per process, not per cluster*. The poller and the web service
 * are two processes with two independent queues, so the guarantee has always
 * been "one writer per process", which is not the guarantee SQLite wants.
 *
 * This closes that, and three other things an in-memory array cannot do:
 *
 * - **Backpressure.** `waiting[]` is unbounded. A database that stops accepting
 *   writes grows an array until the process dies with it, losing every queued
 *   write. A Redis queue has a depth you can read, alert on, and refuse to add
 *   to.
 * - **Durability.** A deploy mid-drain drops whatever was queued. Here the job
 *   outlives the process that enqueued it.
 * - **Retries.** A transport failure is currently the caller's problem, because
 *   retrying a whole remote transaction from inside the drain loop would
 *   amplify an outage. A queue retries one job with a backoff, which is the
 *   thing that was actually wanted.
 *
 * **The semantics are deliberately unchanged.** `client.batch()` still returns a
 * promise of the same results and still rejects with the same errors: the job
 * is enqueued and awaited. That is what makes this a drop-in for a hundred call
 * sites rather than a rewrite of all of them — and it is why the cost is one
 * Redis round trip on a path that already costs a ~370ms remote transaction.
 *
 * Fire-and-forget was the alternative and is rejected on purpose. `storeCrawl`
 * reads `rowsAffected` off its own write to decide how many posts it stored,
 * and a crawl that cannot tell whether it stored anything reschedules the feed
 * wrongly. Losing the result to gain a few milliseconds is a bad trade.
 *
 * Reads never come near this, for the reason they never came near
 * `serializeWrites`: they do not take the write lock, and putting a web
 * request behind a crawl is the failure this is meant to prevent.
 */

/** The one queue. Named rather than derived so two deploys cannot disagree. */
export const WRITE_QUEUE = 'turso-writes';

/**
 * How long a caller waits for its write before giving up.
 *
 * Longer than the database's own request deadline, because this wait contains
 * that one: a job that is still queued has not started spending it yet. Short
 * enough that a wedged writer surfaces as failing requests rather than as a web
 * server holding every connection open.
 */
const WAIT_MS = 120_000;

/**
 * Encode one libSQL value for JSON.
 *
 * Two types do not survive `JSON.stringify` and both occur here: SQLite
 * integers arrive as BigInt whenever they exceed the safe range, and blobs are
 * Uint8Array. Everything else is already JSON. Tagged rather than coerced,
 * because silently turning a BigInt id into a Number is how a row gets written
 * against the wrong key.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function encodeValue(value) {
  if (typeof value === 'bigint') return { __t: 'bigint', v: value.toString() };
  if (value instanceof Uint8Array) return { __t: 'bytes', v: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return { __t: 'date', v: value.toISOString() };
  return value;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function decodeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  const tag = /** @type {{ __t?: string, v?: string }} */ (value);
  if (tag.__t === 'bigint') return BigInt(String(tag.v));
  if (tag.__t === 'bytes') return new Uint8Array(Buffer.from(String(tag.v), 'base64'));
  if (tag.__t === 'date') return new Date(String(tag.v));
  return value;
}

/**
 * Put a statement on the wire.
 *
 * Accepts both shapes the codebase uses: `{ sql, args }` and a bare SQL string.
 * Named arguments are an object rather than an array, so both are carried.
 *
 * @param {unknown} statement
 * @returns {{ sql: string, args: unknown }}
 */
export function encodeStatement(statement) {
  if (typeof statement === 'string') return { sql: statement, args: [] };

  const stmt = /** @type {{ sql?: unknown, args?: unknown }} */ (statement ?? {});
  const args = stmt.args;

  if (Array.isArray(args)) return { sql: String(stmt.sql), args: args.map(encodeValue) };
  if (args && typeof args === 'object') {
    return {
      sql: String(stmt.sql),
      args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, encodeValue(v)])),
    };
  }

  return { sql: String(stmt.sql), args: [] };
}

/**
 * @param {{ sql: string, args: unknown }} statement
 * @returns {{ sql: string, args: unknown }}
 */
export function decodeStatement(statement) {
  const args = statement.args;
  if (Array.isArray(args)) return { sql: statement.sql, args: args.map(decodeValue) };
  if (args && typeof args === 'object') {
    return {
      sql: statement.sql,
      args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, decodeValue(v)])),
    };
  }
  return { sql: statement.sql, args: [] };
}

/**
 * Reduce a ResultSet to what crosses the wire.
 *
 * Only the parts callers in this codebase read: `rowsAffected`, which several
 * reduce over, and `rows`, which `storeCrawl` reads for its RETURNING clause.
 * `lastInsertRowid` rides along because it is a BigInt and dropping it silently
 * would be a trap for whoever needs it next.
 *
 * Rows come back as plain objects rather than libSQL's array-like Row. Every
 * caller here reads them by column name; none indexes them positionally.
 *
 * @param {unknown} result
 * @returns {object}
 */
export function encodeResult(result) {
  const set = /** @type {{ rows?: unknown[], rowsAffected?: number, lastInsertRowid?: unknown, columns?: unknown[] }} */ (
    result ?? {}
  );

  return {
    rowsAffected: Number(set.rowsAffected ?? 0),
    lastInsertRowid: encodeValue(set.lastInsertRowid),
    columns: Array.isArray(set.columns) ? set.columns.map((c) => String(c)) : [],
    rows: Array.isArray(set.rows)
      ? set.rows.map((row) =>
          Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, encodeValue(v)])),
        )
      : [],
  };
}

/**
 * @param {object} encoded
 * @returns {object}
 */
export function decodeResult(encoded) {
  const set = /** @type {{ rows?: object[], rowsAffected?: number, lastInsertRowid?: unknown, columns?: string[] }} */ (
    encoded ?? {}
  );

  return {
    rowsAffected: Number(set.rowsAffected ?? 0),
    lastInsertRowid: decodeValue(set.lastInsertRowid),
    columns: set.columns ?? [],
    rows: (set.rows ?? []).map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, decodeValue(v)])),
    ),
  };
}

/**
 * The Redis connection options BullMQ needs.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ for its blocking clients
 * and is not optional styling — ioredis otherwise fails a blocking BRPOPLPUSH
 * after the default retry count and the worker stops consuming.
 *
 * @param {string} url
 * @returns {object}
 */
export function connectionFor(url) {
  return { url, maxRetriesPerRequest: null };
}

/**
 * Route a client's write transactions through the queue.
 *
 * The same one-method override `serializeWrites` uses, and for the same
 * reason its comment gives: libSQL keeps private class fields, so wrapping the
 * client in a Proxy throws the moment anything reads one.
 *
 * @param {import('@libsql/client').Client} client
 * @param {{ url: string, prefix?: string, attempts?: number }} opts
 * @returns {import('@libsql/client').Client & { closeWriteQueue: () => Promise<void> }}
 */
export function queueWrites(client, opts) {
  const connection = connectionFor(opts.url);
  // The Redis instance is shared with every other app in the Railway project,
  // so the keyspace is claimed explicitly rather than left on BullMQ's default.
  const prefix = opts.prefix ?? '{rssamplifier}';

  const queue = new Queue(WRITE_QUEUE, { connection, prefix });
  const events = new QueueEvents(WRITE_QUEUE, { connection, prefix });
  const original = client.batch.bind(client);

  /**
   * @param {unknown[]} statements
   * @returns {Promise<unknown>}
   */
  const enqueue = async (statements) => {
    const job = await queue.add(
      'batch',
      { statements: Array.from(statements ?? []).map(encodeStatement) },
      {
        attempts: opts.attempts ?? 3,
        // A transport failure wants a moment before the retry; a contended
        // write wants rather more. Exponential covers both without a knob.
        backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: true,
        // Kept, because a write that failed every attempt is the thing you go
        // looking for afterwards. Bounded so the list cannot become the leak.
        removeOnFail: 1000,
      },
    );

    const encoded = await job.waitUntilFinished(events, WAIT_MS);
    return /** @type {object[]} */ (encoded).map(decodeResult);
  };

  client.batch = (statements, mode) =>
    mode === 'read' ? original(statements, mode) : enqueue(statements);

  // `transaction()` is left alone for the reason serializeWrites leaves it
  // alone: it hands out a lock held across awaits, which no queue can bound.

  return Object.assign(client, {
    closeWriteQueue: async () => {
      await queue.close();
      await events.close();
    },
  });
}

/**
 * The single consumer that actually writes.
 *
 * **Concurrency is 1 and must stay 1.** This is the whole point: SQLite permits
 * one writer, so one worker taking one job at a time is the global serialisation
 * the in-process queue could only approximate. Raising it re-creates the
 * livelock this was built to end, across machines this time, where it is harder
 * to see.
 *
 * The client handed in must be a *raw* one, not a queued one, or every job
 * enqueues another job and nothing ever writes.
 *
 * @param {import('@libsql/client').Client} client a client with no write queue on it
 * @param {{ url: string, prefix?: string, onEvent?: ((event: object) => void)|null }} opts
 * @returns {import('bullmq').Worker}
 */
export function createWriteWorker(client, opts) {
  const connection = connectionFor(opts.url);
  const prefix = opts.prefix ?? '{rssamplifier}';

  return new Worker(
    WRITE_QUEUE,
    async (job) => {
      const statements = (job.data.statements ?? []).map(decodeStatement);
      if (statements.length === 0) return [];

      const results = await client.batch(statements, 'write');
      return Array.from(results ?? []).map(encodeResult);
    },
    { connection, prefix, concurrency: 1 },
  );
}
