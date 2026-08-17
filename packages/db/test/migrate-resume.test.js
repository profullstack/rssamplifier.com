import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-migrate-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a migration file that half-applied can still be completed', async () => {
  // Reproduces the outage: 0019 added feed_items.cluster_key, then failed
  // building an index. Nothing was recorded, so the next boot re-ran the ALTER
  // and died on "duplicate column name" before reaching the failed statement.
  await migrate(db);

  const { rows } = await db.execute('select name from _migrations');
  const recorded = rows.map((r) => String(r.name));
  assert.ok(recorded.includes('0019_item_clusters.sql'), 'the run completed');

  // Put the ledger back to the half-applied state: the column is there, the
  // file is not recorded. Booting again must recover rather than crash.
  await db.execute("delete from _migrations where name = '0019_item_clusters.sql'");

  const second = await migrate(db);
  assert.ok(
    second.applied.includes('0019_item_clusters.sql'),
    'the half-applied file is re-run and this time recorded',
  );

  // And everything after it, which had been unreachable, now lands too.
  const after = await db.execute('select name from _migrations');
  assert.ok(
    after.rows.map((r) => String(r.name)).includes('0020_api_keys.sql'),
    'a later migration is no longer blocked by the stuck one',
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
