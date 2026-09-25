import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { connectTest } from '../src/testdb.js';
import { migrate } from '../src/migrate.js';

let db;

before(async () => {
  // connectTest() has already run migrate() once; every test here starts from
  // a settled ledger.
  db = await connectTest();
});

after(async () => {
  db.close();
});

test('a migration file that half-applied can still be completed', async () => {
  // Reproduces the outage: under SQLite, 0019 added feed_items.cluster_key and
  // then failed building an index. Nothing was recorded, so the next boot re-ran
  // the ALTER and died on "duplicate column name" before reaching the failed
  // statement. Postgres has the same exposure: each statement is its own
  // autocommit, so a file that dies halfway leaves its earlier `create`s in
  // place with no ledger row, and the next boot must step over them to reach
  // the one that failed. Every statement in 0001_schema.sql is `if not exists`,
  // so the re-run below succeeds statement by statement; a bare `create` would
  // report "already exists" instead, which migrate() tolerates the same way.
  const { rows } = await db.execute('select name from _migrations');
  const recorded = rows.map((r) => String(r.name));
  assert.ok(recorded.includes('0001_schema.sql'), 'the run completed');

  // Put the ledger back to the half-applied state: every object is there, the
  // file is not recorded. Booting again must recover rather than crash.
  await db.execute("delete from _migrations where name = '0001_schema.sql'");

  const second = await migrate(db);
  assert.ok(
    second.applied.includes('0001_schema.sql'),
    'the half-applied file is re-run and this time recorded',
  );

  // And the ledger is whole again, so the next boot has nothing to do.
  const after = await db.execute('select name from _migrations');
  assert.deepEqual(
    after.rows.map((r) => String(r.name)),
    ['0001_schema.sql'],
    'recorded exactly once',
  );
});

test('a real error still stops the run', async () => {
  // The tolerance must not turn into "ignore failures": a broken statement has
  // to stop the boot, or a half-applied schema gets recorded as complete.
  await assert.rejects(async () => {
    for (const statement of ['select * from a_table_that_does_not_exist']) {
      await db.execute(statement);
    }
  });
});

test('migrate stays idempotent', async () => {
  const again = await migrate(db);
  assert.equal(again.applied.length, 0, 'a settled database applies nothing');
  assert.ok(again.skipped.length > 0);
});
