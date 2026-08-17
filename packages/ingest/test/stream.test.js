import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q } from '@rssamplifier/db';

import { importFeeds } from '../src/import.js';
import { submitCatalogueStream, submitOpmlStream } from '../src/submit.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-stream-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An async iterable of `n` catalogue entries, made up on demand. */
async function* entries(prefix, n) {
  for (let i = 0; i < n; i++) {
    yield { url: `https://${prefix}${i}.example/rss`, title: `${prefix} ${i}` };
  }
}

test('importFeeds takes an async iterable and queues the same rows as an array', async () => {
  const streamed = await importFeeds(db, entries('s', 30), { submissionId: 'stream-import' });

  assert.equal(streamed.inserted, 30);
  assert.equal(streamed.total, 30, 'total is counted as the stream is read');

  const rows = await db.execute({
    sql: 'select count(*) as n from feeds where submission_id = ?',
    args: ['stream-import'],
  });
  assert.equal(Number(rows.rows[0].n), 30);
});

test('a streamed import still spreads its schedule instead of stacking it', async () => {
  await importFeeds(db, entries('spread', 40), { submissionId: 'stream-spread' });

  const rows = await db.execute({
    sql: 'select distinct next_fetch_at from feeds where submission_id = ?',
    args: ['stream-spread'],
  });

  // The array path divides by a known total; the stream deals into slots. Both
  // must produce more than one due-time, or the poller gets the whole import at
  // once — which is the thing the spread exists to prevent.
  assert.ok(rows.rows.length > 1, `everything came due together (${rows.rows.length} distinct)`);
});

test('a streamed catalogue resolves the head and queues the tail', async () => {
  const res = await submitCatalogueStream(db, entries('cat', 120), {
    submissionId: 'stream-catalogue',
    inlineLimit: 5,
  });

  assert.equal(res.total, 120, 'every entry was seen');
  assert.equal(res.queued, 115, 'everything past the inline limit was queued');
  // The head is resolved over the network, and these hosts do not exist, so
  // they land in `rejected` rather than `accepted`. What matters here is that
  // exactly the inline limit was attempted.
  assert.equal(res.accepted.length + res.rejected.length, 5);
});

test('a streamed OPML upload reads the document without holding it', async () => {
  async function* chunks() {
    yield '<?xml version="1.0"?><opml><body>';
    for (let i = 0; i < 300; i++) {
      yield Buffer.from(`<outline text="O ${i}" xmlUrl="https://o${i}.example/rss" />`);
    }
    yield '</body></opml>';
  }

  const res = await submitOpmlStream(db, chunks(), {
    submissionId: 'stream-opml',
    inlineLimit: 2,
  });

  assert.equal(res.total, 300);
  assert.equal(res.queued, 298);

  const rows = await db.execute({
    sql: 'select count(*) as n from feeds where submission_id = ?',
    args: ['stream-opml'],
  });
  assert.equal(Number(rows.rows[0].n), 298);
});

test('an upload with no outlines is rejected in the same words as a parsed one', async () => {
  const res = await submitOpmlStream(db, ['<opml><body></body></opml>'], {
    submissionId: 'stream-empty',
  });

  assert.equal(res.total, 0);
  assert.deepEqual(res.rejected, [{ url: '', error: 'no-feeds-in-opml' }]);
});

test('an upload past its byte ceiling keeps what it had already queued', async () => {
  // Comfortably more than one flush: the importer writes in batches of 500, so
  // an upload refused before the first batch has nothing to have kept, and a
  // fixture smaller than a batch would be testing the batch size rather than
  // the durability.
  async function* tooMuch() {
    yield '<opml><body>';
    for (let i = 0; i < 1_200; i++) {
      yield `<outline text="B ${i}" xmlUrl="https://b${i}.example/rss" />`;
    }
    // Now run it well past the ceiling set below.
    for (let i = 0; i < 64; i++) yield 'x'.repeat(1024);
  }

  await assert.rejects(
    () =>
      submitOpmlStream(db, tooMuch(), {
        submissionId: 'stream-toobig',
        inlineLimit: 1,
        maxBytes: 96 * 1024,
      }),
    /exceeds/,
  );

  // The point of streaming: work already done is durable. A refused upload is
  // not an all-or-nothing rollback, and the status page has something true to
  // report rather than a silent nothing.
  const rows = await db.execute({
    sql: 'select count(*) as n from feeds where submission_id = ?',
    args: ['stream-toobig'],
  });
  assert.ok(Number(rows.rows[0].n) >= 1_000, `only ${rows.rows[0].n} survived the refusal`);
});
