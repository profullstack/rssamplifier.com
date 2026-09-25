import pg from 'pg';

/**
 * PostgreSQL behind the libSQL client surface.
 *
 * Every query in this codebase was written against `@libsql/client`:
 * `db.execute({ sql, args })`, `db.execute(sql, args)`, `db.batch(statements,
 * mode)`, results with `rows`, `columns`, `rowsAffected`. Rather than rewrite
 * nine hundred call sites, the same surface is served by Postgres here, and the
 * SQL itself moved from SQLite's dialect to Postgres's where the two differ
 * (see migrations-pg/README.md for the list).
 *
 * What this layer translates:
 *   - `?` placeholders become `$1..$n`, outside string literals and comments.
 *   - `rows` are plain objects keyed by column name, as libSQL returned them.
 *     `rowsAffected` is Postgres's row count. `lastInsertRowid` is never set:
 *     the one place that needs an inserted id uses RETURNING.
 *   - int8/numeric come back as JS numbers, not strings. Nothing here counts
 *     past 2^53, and every caller does arithmetic on counts.
 *   - `batch(statements, mode)` runs the statements in one transaction on one
 *     connection and returns one result per statement, in order.
 *
 * What it deliberately does not do: emulate SQLite's single writer. Postgres
 * has row locks, so the in-process write queue and the Redis write worker that
 * kept Turso alive are no longer wired by default (WRITE_QUEUE=1 turns the Redis
 * path back on for a deployment that wants one writer anyway).
 */

const { Pool, types } = pg;

/** @typedef {ReturnType<typeof createPgClient>} PgClient */

// int8 (20), numeric (1700): numbers, not strings. int4/float already are.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// Postgres timestamps are not used: every time column is ISO-8601 text, as in
// the SQLite schema, so ordering and range queries carry over unchanged.

/**
 * Turn `?` placeholders into `$1..$n`.
 *
 * Skips single-quoted literals (with '' escapes), double-quoted identifiers,
 * `--` line comments and `/* *\/` block comments, and Postgres casts (`::`)
 * are untouched because they contain no `?`. A `?` that is already a jsonb
 * operator (`?`, `?|`, `?&`) is not used anywhere in this codebase.
 *
 * @param {string} sql
 * @returns {string}
 */
export function positional(sql) {
  let out = '';
  let n = 0;
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '"') {
      const j = sql.indexOf('"', i + 1);
      const end = j === -1 ? len - 1 : j;
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? len : j;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j === -1 ? len : j + 2;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '?') {
      n += 1;
      out += `$${n}`;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * libSQL accepts `execute(sql)`, `execute(sql, args)` and `execute({ sql, args })`.
 *
 * @param {string|{ sql: string, args?: unknown[] }} statement
 * @param {unknown[]} [args]
 * @returns {{ sql: string, args: unknown[] }}
 */
function normalize(statement, args) {
  if (typeof statement === 'string') return { sql: statement, args: args ?? [] };
  return { sql: statement.sql, args: statement.args ?? [] };
}

/**
 * libSQL binds JS values loosely; pg is stricter. Booleans become 0/1 because
 * every flag column is an integer, as it was in SQLite. BigInts become numbers.
 * Undefined is null. Dates become ISO strings, the storage format here.
 *
 * @param {unknown[]} args
 */
function bind(args) {
  return args.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'bigint') return Number(v);
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Uint8Array) return Buffer.from(v);
    return v;
  });
}

/**
 * @param {import('pg').QueryResult} res
 */
function toResultSet(res) {
  const columns = (res.fields ?? []).map((f) => f.name);
  return {
    columns,
    columnTypes: (res.fields ?? []).map(() => ''),
    rows: res.rows,
    rowsAffected: res.rowCount ?? 0,
    lastInsertRowid: undefined,
    toJSON() {
      return { columns, rows: res.rows, rowsAffected: res.rowCount ?? 0 };
    },
  };
}

/**
 * Something a pg query throws, reshaped so the message reads like the SQLite
 * one where code inspects it. Only two spots do: the migration runner's
 * "already exists" test (Postgres says the same words), and callers that catch
 * a unique violation by its wording.
 *
 * @param {any} err
 */
function translateError(err) {
  if (err && err.code === '23505') {
    const e = new Error(`UNIQUE constraint failed: ${err.constraint ?? err.detail ?? ''}`.trim());
    e.cause = err;
    // @ts-ignore
    e.code = err.code;
    return e;
  }
  return err;
}

/**
 * Run one statement on a pg client or pool.
 *
 * @param {{ query: Function }} target
 * @param {{ sql: string, args: unknown[] }} st
 */
async function run(target, st) {
  try {
    const res = await target.query({ text: positional(st.sql), values: bind(st.args), rowMode: undefined });
    return toResultSet(res);
  } catch (err) {
    throw translateError(err);
  }
}

/**
 * Open a Postgres pool that speaks the libSQL client surface.
 *
 * @param {{ url: string, max?: number, statementTimeoutMs?: number, applicationName?: string }} opts
 */
export function createPgClient(opts) {
  // pg lets `sslmode=` in the connection string override the `ssl` option, and
  // its `require` verifies the certificate. The box's cert is self-signed (the
  // app never verified Turso's either), so the parameter is read here and taken
  // out of the URL: TLS on, verification off.
  const wantTls = /sslmode=(require|prefer|verify-ca|verify-full)/.test(opts.url);
  const parsed = new URL(opts.url);
  parsed.searchParams.delete('sslmode');
  const url = parsed.toString();
  const pool = new Pool({
    connectionString: url,
    max: opts.max ?? 10,
    ssl: wantTls ? { rejectUnauthorized: false } : undefined,
    application_name: opts.applicationName ?? 'rssamplifier',
    statement_timeout: opts.statementTimeoutMs,
    allowExitOnIdle: true,
  });
  pool.on('error', () => {
    /* an idle connection dropped by the server; the next query reconnects */
  });

  const client = {
    /** @type {'postgres'} */
    protocol: 'postgres',
    closed: false,

    /**
     * @param {string|{ sql: string, args?: unknown[] }} statement
     * @param {unknown[]} [args]
     */
    async execute(statement, args) {
      return run(pool, normalize(statement, args));
    },

    /**
     * One transaction, one connection, one result per statement.
     *
     * @param {Array<string|{ sql: string, args?: unknown[] }>} statements
     * @param {'write'|'read'|'deferred'} [mode]
     */
    async batch(statements, mode = 'deferred') {
      const conn = await pool.connect();
      try {
        await conn.query(mode === 'read' ? 'begin read only' : 'begin');
        const results = [];
        for (const s of statements) results.push(await run(conn, normalize(s)));
        await conn.query('commit');
        return results;
      } catch (err) {
        try { await conn.query('rollback'); } catch { /* connection already gone */ }
        throw err;
      } finally {
        conn.release();
      }
    },

    /**
     * An interactive transaction, for the rare caller that holds one across
     * awaits. Same surface as libSQL's Transaction.
     *
     * @param {'write'|'read'|'deferred'} [mode]
     */
    async transaction(mode = 'deferred') {
      const conn = await pool.connect();
      let open = true;
      await conn.query(mode === 'read' ? 'begin read only' : 'begin');
      const finish = async (verb) => {
        if (!open) return;
        open = false;
        try { await conn.query(verb); } finally { conn.release(); }
      };
      return {
        execute: (statement, args) => run(conn, normalize(statement, args)),
        batch: async (statements) => {
          const out = [];
          for (const s of statements) out.push(await run(conn, normalize(s)));
          return out;
        },
        commit: () => finish('commit'),
        rollback: () => finish('rollback'),
        close: () => finish('rollback'),
        get closed() { return !open; },
      };
    },

    /** libSQL's multi-statement runner; used by the migration runner's tests. */
    async executeMultiple(sql) {
      const conn = await pool.connect();
      try {
        await conn.query(sql);
      } finally {
        conn.release();
      }
    },

    async sync() {},

    close() {
      if (client.closed) return;
      client.closed = true;
      void pool.end();
    },

    /** Escape hatch for code that wants the pool itself (COPY, listen/notify). */
    pool,
  };
  return client;
}
