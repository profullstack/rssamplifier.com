/**
 * One write transaction at a time, with waiting callers folded into the next.
 *
 * Extracted from `serializeWrites` so the Redis queue can use the same thing.
 * It was the in-process queue's whole advantage and the Redis path did not have
 * it: `queueWrites` posted one job per caller, each job became one remote
 * transaction, and with a worker at concurrency 1 that put a hard ceiling on
 * cluster write throughput of one transaction's latency — about 370ms, so
 * roughly 2.7 writes a second for every process combined. Measured in
 * production on 2026-08-19: the import drain stopped entirely for over an hour
 * behind a queue of small crawl batches, and item ingestion halved.
 *
 * The mechanism is deliberately dumb. The first caller runs immediately.
 * Everyone who arrives while it is awaiting the database accumulates, and the
 * next turn sends them as one transaction, up to a statement ceiling. SQLite
 * was going to serialise them anyway; this pays the round trip once instead of
 * once per caller.
 *
 * Nothing here knows whether `run` writes to a database directly or posts a job
 * to a queue. That is the point — the folding is worth having on both paths.
 */

/**
 * Hand each caller the result rows belonging to its own statements.
 *
 * libSQL returns one ResultSet per statement, in order. A caller above this
 * layer must never learn that its transaction shared a round trip.
 *
 * @param {Array<{ statements: unknown[], resolve: (value: unknown) => void }>} group
 * @param {unknown[]} results
 */
export function settleGroup(group, results) {
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
export function isStatementError(err) {
  const text = String(err?.message ?? err);
  return /SQLITE_(?:CONSTRAINT|ERROR|MISMATCH|RANGE)|constraint failed|syntax error|no such (?:table|column)/i.test(
    text,
  );
}

/**
 * Build the folding enqueue function.
 *
 * @param {{
 *   run: (statements: unknown[]) => Promise<unknown[]>,
 *   maxStatements?: number,
 * }} opts `run` performs one transaction's worth of statements
 * @returns {(statements: unknown[]) => Promise<unknown>}
 */
export function createWriteFolder({ run, maxStatements = 1 }) {
  const ceiling = Number.isFinite(maxStatements) && maxStatements > 0 ? Math.floor(maxStatements) : 1;

  /** @type {Array<{ statements: unknown[], resolve: (value: unknown) => void, reject: (reason: unknown) => void }>} */
  const waiting = [];
  let draining = false;

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
          // The first caller always goes in, however large it is: a ceiling
          // that could refuse the only waiting caller would deadlock.
          if (group.length > 0 && statementCount + size > ceiling) break;
          group.push(waiting.shift());
          statementCount += size;
        }

        const statements = group.flatMap((entry) => entry.statements);

        try {
          const results = await run(statements);
          settleGroup(group, Array.from(results ?? []));
        } catch (err) {
          if (group.length > 1 && isStatementError(err)) {
            // The transaction was rejected because one statement is bad. Run
            // each caller on its own to preserve failure isolation and ordering.
            for (const entry of group) {
              try {
                entry.resolve(await run(entry.statements));
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
    }
  }

  return (statements) =>
    new Promise((resolve, reject) => {
      waiting.push({ statements: Array.from(statements ?? []), resolve, reject });
      void drain();
    });
}
