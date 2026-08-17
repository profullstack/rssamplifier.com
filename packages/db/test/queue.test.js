import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as a from '../src/accounts.js';
import * as q from '../src/queries.js';
import * as queue from '../src/queue.js';

let dir;
let db;
let alice;
let bob;
/** @type {string[]} */
let items = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-queue-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);

  const feed = await q.insertFeed(db, {
    slug: 'queue-blog',
    feed_url: 'https://queue.example/feed.xml',
    site_url: 'https://queue.example/',
    title: 'Queue Blog',
  });

  await q.upsertItems(db, feed.id, [
    { guid: 'one', title: 'One', publishedAt: '2026-08-01T00:00:00Z' },
    { guid: 'two', title: 'Two', publishedAt: '2026-08-02T00:00:00Z' },
    { guid: 'three', title: 'Three', publishedAt: '2026-08-03T00:00:00Z' },
  ]);

  items = [];
  for (const guid of ['one', 'two', 'three']) {
    const item = await q.itemByGuid(db, feed.id, guid);
    items.push(String(item.id));
  }

  alice = (await a.findOrCreateUser(db, 'alice@queue.example')).id;
  bob = (await a.findOrCreateUser(db, 'bob@queue.example')).id;
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('entries queue in the order they were added', async () => {
  for (const id of items) await queue.add(db, alice, id, 'listen');

  const lane = await queue.list(db, alice, 'listen');
  assert.deepEqual(
    lane.map((row) => String(row.title)),
    ['One', 'Two', 'Three'],
  );
});

test('adding something twice is a double click, not a second intention', async () => {
  const before = await queue.list(db, alice, 'listen');
  await queue.add(db, alice, items[0], 'listen');
  const after = await queue.list(db, alice, 'listen');

  assert.equal(after.length, before.length);
  assert.equal(String(after[0].title), 'One', 'it kept its place rather than going to the back');
});

test('the same post can wait in two lanes at once', async () => {
  await queue.add(db, alice, items[0], 'read');

  const lanes = await queue.lanesForItems(db, alice, [items[0]]);
  assert.deepEqual([...lanes[items[0]]].sort(), ['listen', 'read']);

  const counts = await queue.counts(db, alice);
  assert.equal(counts.listen, 3);
  assert.equal(counts.read, 1);
  assert.equal(counts.watch, 0, 'an untouched lane still answers');
});

test('moving an entry swaps it with its neighbour', async () => {
  const lane = await queue.list(db, alice, 'listen');
  const second = String(lane[1].id);

  assert.equal(await queue.move(db, alice, second, 'up'), true);
  assert.deepEqual(
    (await queue.list(db, alice, 'listen')).map((row) => String(row.title)),
    ['Two', 'One', 'Three'],
  );

  // Already at the top: nothing to swap with, and nothing to report but false.
  const top = String((await queue.list(db, alice, 'listen'))[0].id);
  assert.equal(await queue.move(db, alice, top, 'up'), false);
});

test('finished entries leave the running order but not the record', async () => {
  const first = String((await queue.list(db, alice, 'listen'))[0].id);
  await queue.setDone(db, alice, first, true);

  const pending = await queue.list(db, alice, 'listen');
  assert.equal(pending.length, 2);
  assert.ok(!pending.some((row) => String(row.id) === first));

  const done = await queue.list(db, alice, 'listen', { done: true });
  assert.equal(done.length, 1);

  // Undo, because the player marks things done on its own and a skip has to be
  // recoverable.
  await queue.setDone(db, alice, first, false);
  assert.equal((await queue.list(db, alice, 'listen')).length, 3);
});

test('re-adding a finished entry brings it back at the end', async () => {
  const lane = await queue.list(db, alice, 'listen');
  const first = lane[0];
  await queue.setDone(db, alice, String(first.id), true);

  await queue.add(db, alice, String(first.item_id), 'listen');

  const after = await queue.list(db, alice, 'listen');
  assert.equal(after.length, 3);
  assert.equal(
    String(after[after.length - 1].item_id),
    String(first.item_id),
    'wanting a thing again is a new intention, so it goes to the back',
  );
});

test("one reader's entry ids are useless against another's queue", async () => {
  const lane = await queue.list(db, alice, 'listen');
  const entry = String(lane[0].id);

  assert.equal(await queue.removeEntry(db, bob, entry), false);
  assert.equal(await queue.setDone(db, bob, entry, true), false);
  assert.equal(await queue.move(db, bob, entry, 'down'), false);
  assert.equal((await queue.list(db, alice, 'listen')).length, 3, "alice's queue is untouched");
});

test('clearing takes either the finished or the lot', async () => {
  await queue.add(db, bob, items[0], 'watch');
  await queue.add(db, bob, items[1], 'watch');

  const lane = await queue.list(db, bob, 'watch');
  await queue.setDone(db, bob, String(lane[0].id), true);

  assert.equal(await queue.clearLane(db, bob, 'watch', { doneOnly: true }), 1);
  assert.equal((await queue.list(db, bob, 'watch')).length, 1);

  assert.equal(await queue.clearLane(db, bob, 'watch'), 1);
  assert.equal((await queue.counts(db, bob)).watch, 0);
});

test('lanes are a closed set', () => {
  assert.equal(queue.isLane('listen'), true);
  assert.equal(queue.isLane('skim'), false);
  assert.equal(queue.isLane(undefined), false);
});
