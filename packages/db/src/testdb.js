import { randomBytes } from 'node:crypto';

import pg from 'pg';

import { connect } from './client.js';
import { migrate } from './migrate.js';

/**
 * A fresh, migrated Postgres database for one test file.
 *
 * The SQLite suite made a temp file per test file and threw it away; this is
 * the same thing for Postgres. Each call creates a database with a random name
 * on the server at TEST_DATABASE_URL (default: the local docker Postgres on
 * 127.0.0.1:5439), migrates it, and returns a client whose `close()` also drops
 * the database. `node --test` runs files in parallel processes, so a database
 * per file is what keeps them from seeing each other's rows.
 *
 * TEST_DATABASE_URL points at a database the test user may create others
 * from; `postgres` is fine.
 *
 * @param {{ prefix?: string }} [opts]
 * @returns {Promise<import('./pg.js').PgClient & { databaseName: string }>}
 */
export async function connectTest(opts = {}) {
  const admin = process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5439/postgres';
  const name = `${opts.prefix ?? 'rssamp_test'}_${randomBytes(6).toString('hex')}`;

  const control = new pg.Client({ connectionString: admin });
  await control.connect();
  try {
    await control.query(`create database "${name}"`);
  } finally {
    await control.end();
  }

  const url = new URL(admin);
  url.pathname = `/${name}`;
  const db = connect({ url: url.toString(), max: 4 });
  await migrate(db);

  const close = db.close.bind(db);
  return Object.assign(db, {
    databaseName: name,
    close() {
      close();
      // Dropping is best effort and asynchronous: a test that forgets to close
      // leaves a small database behind, which is a nuisance, not a failure.
      void (async () => {
        const c = new pg.Client({ connectionString: admin });
        try {
          await c.connect();
          await c.query(`drop database if exists "${name}" with (force)`);
        } catch {
          /* ignore */
        } finally {
          await c.end().catch(() => {});
        }
      })();
    },
  });
}
