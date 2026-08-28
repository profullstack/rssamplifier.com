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

  // The entry rather than its fields: `entry.events` is replaced in place when
  // a dead consumer is rebuilt, and a destructured copy would pin every future
  // wait to the corpse. See `reviveEvents`.
  const entry = sharedQueue(opts.url, prefix);
  const original = client.batch.bind(client);

  /**
   * @param {unknown[]} statements
   * @returns {Promise<unknown>}
   */
  const enqueue = async (statements) => {
    const job = await entry.queue.add(
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
        // Was `true`, which deletes the job the instant it succeeds. That is
        // the tidy answer and it made a lost notification unrecoverable: the
        // waiter times out, goes looking for the job to ask whether its write
        // actually landed, and finds nothing — so a write that *committed* is
        // reported to the crawler as a failure, and a healthy feed collects an
        // error and a re-crawl for a row it already stored.
        //
        // A short retention gives `recoverFinished` something to read. Two
        // hundred is a couple of minutes of queue at full rate, which is far
        // longer than the window between a completion and the waiter noticing
        // it, and small enough to stay invisible next to a 1MB Redis.
        removeOnComplete: { count: 200 },
        // Kept, because a write that failed every attempt is the thing you go
        // looking for afterwards. Bounded so the list cannot become the leak.
        removeOnFail: 1000,
      },
    );

    try {
      const encoded = await job.waitUntilFinished(entry.events, WAIT_MS);
      return /** @type {object[]} */ (encoded).map(decodeResult);
    } catch (err) {
      if (!isWaitTimeout(err)) throw err;

      // The wait expired. Either the job really is still running, or nobody
      // told us it finished — and those two want opposite responses, so ask
      // the queue rather than guessing. `recoverFinished` reads the job's own
      // state, which is the one answer that does not depend on the event
      // stream that just failed us.
      const recovered = await recoverFinished(job);

      // A job that had already finished is proof the notification was lost
      // rather than late, so the consumer is rebuilt either way. The only
      // difference the result makes is whether this caller still has to fail.
      await reviveEvents(entry);

      if (recovered) return recovered.map(decodeResult);
      throw err;
    }
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
 * @type {Map<string, Entry>}
 */
const shared = new Map();

/**
 * @typedef {{
 *   queue: import('bullmq').Queue,
 *   events: import('bullmq').QueueEvents,
 *   url: string,
 *   prefix: string,
 *   refs: number,
 *   lastEventAt: number,
 * }} Entry
 */

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
    events: newEvents(url, prefix),
    url,
    prefix,
    refs: 1,
    lastEventAt: Date.now(),
  };

  // Once, at construction rather than in `watchEvents`, which runs again on
  // every revive. An `error` with no listener is a throw, and BullMQ reports
  // connection trouble on the object it happened to.
  entry.queue.on('error', () => {});

  watchEvents(entry);
  shared.set(key, entry);
  return entry;
}

/**
 * @param {string} url
 * @param {string} prefix
 * @returns {import('bullmq').QueueEvents}
 */
function newEvents(url, prefix) {
  return new QueueEvents(WRITE_QUEUE, { connection: connectionFor(url), prefix });
}

/**
 * Keep a pulse on the event consumer, and stop its failures being silent.
 *
 * Both halves of this were missing and the outage needed both. BullMQ's
 * `QueueEvents` swallows connection errors inside its own read loop and
 * re-emits them on itself; with no `error` listener attached, node's
 * EventEmitter turns that into a throw which BullMQ then catches and discards.
 * So the consumer can stop being a consumer without a single line in the log.
 *
 * `lastEventAt` is the pulse. The queue emits `added` and `active` for every
 * job and `completed` or `failed` for every outcome, so a consumer that is
 * reading at all cannot be quiet for long while work is going through. That is
 * what lets a wait timeout tell "the job is slow" from "nobody is listening" —
 * see `reviveEvents`.
 *
 * @param {Entry} entry
 */
function watchEvents(entry) {
  const beat = () => {
    entry.lastEventAt = Date.now();
  };

  for (const name of ['added', 'active', 'completed', 'failed', 'drained']) {
    entry.events.on(name, beat);
  }

  entry.events.on('error', beat);
}

/**
 * Replace an event consumer that has stopped consuming.
 *
 * The failure this exists for: the consumer's Redis connection went away
 * without the socket ever erroring — the server had no such client left, while
 * this process sat in a read that would never return. `checkConnectionError`
 * only retries errors, and there was no error, so the loop never came round
 * again. Nothing in BullMQ notices this and nothing in it recovers, and because
 * `createWriteFolder` keeps exactly one job in flight per process, the whole
 * cluster fell to one write attempt per `WAIT_MS` — for seventeen hours, with a
 * healthy database, a healthy worker, and writes that were landing the whole
 * time.
 *
 * Guarded on the pulse so a genuinely slow job does not cost a reconnect: if
 * the consumer has reported anything at all within the last `WAIT_MS`, it is
 * alive and the wait was simply too short.
 *
 * The old object is closed for its connection's sake, but not waited on — it is
 * wedged in a read, which is the entire problem, so awaiting its close is the
 * one thing guaranteed to hang.
 *
 * @param {Entry} entry
 * @returns {Promise<void>}
 */
async function reviveEvents(entry) {
  if (Date.now() - entry.lastEventAt < WAIT_MS) return;

  const dead = entry.events;
  entry.events = newEvents(entry.url, entry.prefix);
  entry.lastEventAt = Date.now();
  watchEvents(entry);

  void Promise.resolve()
    .then(() => dead.close())
    .catch(() => {});
}

/**
 * Whether an error is `waitUntilFinished` giving up, rather than a real failure.
 *
 * Matched on the message because BullMQ throws a plain `Error` for it — there
 * is no class to test and no code on it.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isWaitTimeout(err) {
  return /timed out before finishing, no finish notification/.test(
    String(/** @type {{ message?: string }} */ (err)?.message ?? err),
  );
}

/**
 * Ask the queue what became of a job whose notification never arrived.
 *
 * Deliberately the same primitive `waitUntilFinished` polls with before it
 * starts listening — `isFinished`, which reads the job's own state rather than
 * anything on the event stream. That is the whole point: the stream is the part
 * that just failed, so the recovery must not consult it.
 *
 * Returns the encoded results if the job had in fact completed, and null if it
 * is genuinely still running or its state cannot be read. A job that failed
 * every attempt throws its own reason, because "UNIQUE constraint failed" is a
 * far better thing to hand a caller than "we waited two minutes".
 *
 * @param {{ id?: string|number, backend: { isFinished: (id: string, returnValue: boolean) => Promise<[number, string]> } }} job
 * @returns {Promise<unknown[]|null>}
 */
export async function recoverFinished(job) {
  let status;
  let result;

  try {
    [status, result] = await job.backend.isFinished(String(job.id), true);
  } catch {
    return null;
  }

  // Still waiting, still running, or gone. Nothing to hand back.
  if (!status) return null;

  // The two codes `waitUntilFinished` treats as failure. `result` is the
  // failedReason rather than a return value.
  if (status === -1 || status === 2) throw new Error(String(result) || 'write job failed');

  try {
    const value = JSON.parse(String(result));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
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
    const encoded = Array.from(results ?? []).map(encodeResult);
    recordWrites(statements, encoded);
    return encoded;
  } catch (err) {
    if (isStatementError(err)) {
      throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

/**
 * What each kind of statement is actually costing, in rows.
 *
 * Turso bills rows written, and until now nothing in this system could say
 * which statements those rows belonged to. Working it out from the outside is
 * guesswork — the account was at 110M rows for a month in which the directory
 * stored 3.3M posts, and narrowing a 30x gap by reading code and multiplying
 * estimates produced two different wrong answers before this existed.
 *
 * Keyed by statement *shape* rather than text: the leading verb and table, with
 * the parameters and whitespace gone, so a million crawls collapse into one
 * line instead of a million.
 *
 * **It counts what the statements report, not what the database charges.**
 * `rowsAffected` is the rows the statement touched; it does not include the
 * work its triggers did, and this schema has six FTS triggers that each write
 * several rows into a shadow table per document. That gap is the point: the
 * difference between this total and Turso's own figure *is* the trigger and
 * index amplification, which is precisely the quantity nothing could see.
 *
 * @type {Map<string, { rows: number, calls: number }>}
 */
const writeTally = new Map();

/**
 * Reduce a statement to the shape it shares with every other one like it.
 *
 * @param {unknown} statement
 * @returns {string}
 */
export function statementShape(statement) {
  const sql = String(
    typeof statement === 'string' ? statement : (statement ?? {}).sql ?? '',
  )
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const verb = /^(insert|update|delete|replace)/.exec(sql)?.[1] ?? 'other';
  const table =
    /^insert\s+(?:or\s+\w+\s+)?into\s+([a-z_]+)/.exec(sql)?.[1] ??
    /^update\s+([a-z_]+)/.exec(sql)?.[1] ??
    /^delete\s+from\s+([a-z_]+)/.exec(sql)?.[1] ??
    /^replace\s+into\s+([a-z_]+)/.exec(sql)?.[1] ??
    '?';

  return `${verb} ${table}`;
}

/**
 * @param {Array<{ sql: string }>} statements
 * @param {Array<{ rowsAffected?: number }>} results
 */
function recordWrites(statements, results) {
  for (let i = 0; i < statements.length; i += 1) {
    const shape = statementShape(statements[i]);
    const rows = Number(results[i]?.rowsAffected ?? 0);
    const seen = writeTally.get(shape) ?? { rows: 0, calls: 0 };
    seen.rows += rows;
    seen.calls += 1;
    writeTally.set(shape, seen);
  }
}

/**
 * The tally so far, biggest first, and reset.
 *
 * Read-and-clear so a caller logging it on a timer reports the interval rather
 * than an ever-growing total nobody can difference by eye.
 *
 * @returns {{ totalRows: number, totalCalls: number, byShape: Array<{ shape: string, rows: number, calls: number }> }}
 */
export function takeWriteTally() {
  const byShape = [...writeTally.entries()]
    .map(([shape, v]) => ({ shape, rows: v.rows, calls: v.calls }))
    .sort((a, b) => b.rows - a.rows);

  writeTally.clear();

  return {
    totalRows: byShape.reduce((n, s) => n + s.rows, 0),
    totalCalls: byShape.reduce((n, s) => n + s.calls, 0),
    byShape,
  };
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
