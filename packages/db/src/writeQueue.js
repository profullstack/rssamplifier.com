import { Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';

import { createWriteFolder, isStatementError } from './writeFolder.js';

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
 * @param {{ url: string, prefix?: string, attempts?: number, backoffMs?: number, maxStatements?: number }} opts
 * @returns {import('@libsql/client').Client & { closeWriteQueue: () => Promise<void> }}
 */
export function queueWrites(client, opts) {
  // The Redis instance is shared with every other app in the Railway project,
  // so the keyspace is claimed explicitly rather than left on BullMQ's default.
  const prefix = opts.prefix ?? '{rssamplifier}';

  const { queue, events } = sharedQueue(opts.url, prefix);
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
        //
        // The base was 500ms, which is the right delay for the failure this
        // was written for — a dropped connection — and the wrong one for the
        // failure that actually happens. In production essentially every
        // retried job is `TURSO_REQUEST_TIMEOUT_MS` expiring, so the first
        // attempt establishes that the database has been too busy to answer
        // for thirty seconds, and a retry 500ms later asks the same
        // still-busy database the same question. At a worker concurrency of
        // one — which is not negotiable, SQLite has one writer — each of
        // those attempts spends thirty seconds of the *cluster's* only write
        // capacity, so a doomed job costs ninety seconds that every other
        // write waits through.
        //
        // Five seconds is still prompt against a thirty-second deadline and
        // gives a contended primary a chance to drain first, which is the
        // only thing that makes the next attempt differ from the last.
        backoff: { type: 'exponential', delay: opts.backoffMs ?? 5_000 },
        removeOnComplete: true,
        // Kept, because a write that failed every attempt is the thing you go
        // looking for afterwards. Bounded so the list cannot become the leak.
        removeOnFail: 1000,
      },
    );

    const encoded = await job.waitUntilFinished(events, WAIT_MS);
    return /** @type {object[]} */ (encoded).map(decodeResult);
  };

  // Callers waiting at the same moment are folded into one job, which is one
  // transaction. Without this every caller was its own job and the worker --
  // correctly at concurrency 1, because SQLite has one writer -- could only
  // retire them at one transaction's latency each. See writeFolder.js.
  const fold = createWriteFolder({ run: enqueue, maxStatements: groupStatements(opts) });

  client.batch = (statements, mode) =>
    mode === 'read' ? original(statements, mode) : fold(statements);

  // `transaction()` is left alone for the reason serializeWrites leaves it
  // alone: it hands out a lock held across awaits, which no queue can bound.

  return Object.assign(client, {
    closeWriteQueue: () => releaseQueue(opts.url, prefix),
  });
}

/**
 * How many statements one queued transaction may carry.
 *
 * Its own knob rather than `TURSO_WRITE_GROUP_STATEMENTS`, so that the queued
 * path and the in-process fallback can be tuned against each other: the
 * in-process one has to survive the 30-second request deadline from inside a
 * crawl worker, where a five-crawl group was once measured to exceed it. On the
 * queued path folding is not an optimisation, it is the difference between a
 * working queue and a 2.7-writes-a-second ceiling, so it defaults on.
 *
 * (This once said `TURSO_WRITE_GROUP_STATEMENTS` "is set to 1 in production".
 * It is set to 50 there and has been for some time; the two knobs being
 * separate is the durable reason, not whatever either is set to this week.)
 *
 * Fifty is deliberately modest: one crawl's worth of statements, so a group is
 * a handful of callers rather than a transaction big enough to hit the deadline
 * the in-process canary hit.
 *
 * @param {{ maxStatements?: number }} opts
 * @returns {number}
 */
function groupStatements(opts) {
  const configured = Number(opts.maxStatements ?? process.env['TURSO_QUEUE_GROUP_STATEMENTS']);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 50;
}

/**
 * One Queue and one QueueEvents per (url, prefix), shared by every caller.
 *
 * `connect()` is called freely -- once per request handler in the web app, more
 * in the poller -- and each call used to build its own pair. Each pair opens
 * Redis connections and registers listeners, so the poller logged
 * `MaxListenersExceededWarning: 11 closing listeners added to [Queue]` within
 * minutes and kept climbing. Refcounted rather than cached outright so that
 * `closeWriteQueue` still means something to a caller that owns the last one.
 *
 * @type {Map<string, { queue: import('bullmq').Queue, events: import('bullmq').QueueEvents, refs: number }>}
 */
const shared = new Map();

/**
 * @param {string} url
 * @param {string} prefix
 */
function sharedQueue(url, prefix) {
  const key = `${prefix}\u0000${url}`;
  const found = shared.get(key);

  if (found) {
    found.refs += 1;
    return found;
  }

  const connection = connectionFor(url);
  const entry = {
    queue: new Queue(WRITE_QUEUE, { connection, prefix }),
    events: new QueueEvents(WRITE_QUEUE, { connection, prefix }),
    refs: 1,
  };

  shared.set(key, entry);
  return entry;
}

/**
 * @param {string} url
 * @param {string} prefix
 * @returns {Promise<void>}
 */
async function releaseQueue(url, prefix) {
  const key = `${prefix}\u0000${url}`;
  const found = shared.get(key);
  if (!found) return;

  found.refs -= 1;
  if (found.refs > 0) return;

  shared.delete(key);
  await found.queue.close();
  await found.events.close();
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
/**
 * Run one write job, and decide whether failing it is worth another attempt.
 *
 * Separated from the `Worker` so it can be tested without a broker: the retry
 * decision is the part with the judgement in it, and the BullMQ plumbing is not.
 *
 * **A retry is only worth a slot if the next attempt could go differently.** At
 * concurrency 1 this is not merely wasted effort, it is head-of-line blocking:
 * a failing job holds the *cluster's only writer* for each of its attempts, and
 * every other write waits behind it.
 *
 * Both halves of that were seen in production within an hour of this queue being
 * switched on. A `UNIQUE constraint failed: authors.slug` job retried three
 * times and could never have succeeded -- the same statements against the same
 * data fail identically for ever. Separately, a timing-out job ran from
 * 21:29:27 to 21:30:29, three attempts at thirty seconds, with the writer held
 * throughout.
 *
 * So a constraint or syntax error is answered with `UnrecoverableError`, which
 * tells BullMQ not to retry: the caller learns at once and the writer is
 * released. Transport failures and timeouts still retry, because those can
 * genuinely go differently on the next attempt -- that is the whole reason the
 * queue was wanted.
 *
 * @param {import('@libsql/client').Client} client
 * @param {Array<{ sql: string, args?: unknown[] }>} statements
 * @returns {Promise<unknown[]>}
 */
export async function runWriteJob(client, statements) {
  if (!statements || statements.length === 0) return [];

  try {
    const results = await client.batch(statements, 'write');
    return Array.from(results ?? []).map(encodeResult);
  } catch (err) {
    if (isStatementError(err)) {
      throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

export function createWriteWorker(client, opts) {
  const connection = connectionFor(opts.url);
  const prefix = opts.prefix ?? '{rssamplifier}';

  return new Worker(
    WRITE_QUEUE,
    (job) => runWriteJob(client, (job.data.statements ?? []).map(decodeStatement)),
    { connection, prefix, concurrency: 1 },
  );
}
