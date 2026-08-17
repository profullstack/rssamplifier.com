import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as q from '../src/queries.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-cluster-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * @param {string} slug
 */
async function feed(slug) {
  return q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example/feed.xml`,
    site_url: `https://${slug}.example/`,
    title: slug,
    kind: 'blog',
  });
}

/**
 * @param {string} id
 * @param {string[]} titles
 */
function items(id, titles) {
  return q.upsertItems(
    db,
    id,
    titles.map((title, i) => ({ guid: `${id}-${i}`, title, url: `https://x.example/${id}/${i}` })),
  );
}

test('an item is given its grouping key as it is stored', async () => {
  const f = await feed('keyed');
  await items(f.id, ['Rust 2.0 has been released today']);

  const { rows } = await db.execute({
    sql: `select cluster_key from feed_items where feed_id = ?`,
    args: [f.id],
  });

  assert.ok(rows[0].cluster_key, 'a substantial title must be keyed');
  assert.notEqual(rows[0].cluster_key, '');
});

test('the same story in two feeds gets the same key', async () => {
  const a = await feed('story-a');
  const b = await feed('story-b');
  await items(a.id, ['A major earthquake has struck the coast']);
  await items(b.id, ['A major earthquake has struck the coast']);

  const { rows } = await db.execute(
    `select distinct cluster_key from feed_items
     where title = 'A major earthquake has struck the coast'`,
  );

  assert.equal(rows.length, 1, 'one story, one key');
});

test('a title too generic to group is marked as such, not left null', async () => {
  const f = await feed('generic');
  await items(f.id, ['Weeknotes']);

  const { rows } = await db.execute({
    sql: `select cluster_key from feed_items where feed_id = ?`,
    args: [f.id],
  });

  // '' means "looked at, never group". NULL would put it back in the backfill
  // worker's queue on every pass, forever.
  assert.equal(rows[0].cluster_key, '');
});

test('the backfill keys old rows and then reports itself finished', async () => {
  const f = await feed('backfill');
  await items(f.id, [
    'The first sufficiently long headline here',
    'The second sufficiently long headline',
    'Weeknotes',
  ]);

  // Put the rows back the way they looked before the column existed.
  await db.execute({
    sql: `update feed_items set cluster_key = null where feed_id = ?`,
    args: [f.id],
  });

  const first = await q.backfillClusterKeys(db, 500);
  assert.equal(first.scanned, 3);
  assert.equal(first.keyed, 2, 'the generic title is scanned but not keyed');

  const { rows } = await db.execute({
    sql: `select count(*) as n from feed_items where feed_id = ? and cluster_key is null`,
    args: [f.id],
  });
  assert.equal(Number(rows[0].n), 0, 'nothing is left null');

  // Self-terminating: a second pass has nothing to claim, which is how the
  // poller knows to stop asking.
  const second = await q.backfillClusterKeys(db, 500);
  assert.equal(second.scanned, 0);
});

test('the backfill honours its batch size so it never holds a long write', async () => {
  const f = await feed('batched');
  await items(
    f.id,
    Array.from({ length: 10 }, (_, i) => `A sufficiently long headline number ${i}`),
  );
  await db.execute({
    sql: `update feed_items set cluster_key = null where feed_id = ?`,
    args: [f.id],
  });

  const pass = await q.backfillClusterKeys(db, 4);
  assert.equal(pass.scanned, 4);
});
