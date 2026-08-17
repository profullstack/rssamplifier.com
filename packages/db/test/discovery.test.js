import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, newId, nowIso } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as q from '../src/queries.js';
import * as discovery from '../src/discovery.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-disc-'));
  db = connect({ url: `file:${join(dir, 'discovery.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Stamp an event time by hand.
 *
 * The production code stamps `nowIso()`, which within one test is liable to
 * produce the same millisecond twice and make the ordering assertions flap.
 * Fixed timestamps make both the order and the `since` boundary exact.
 *
 * @param {string} table
 * @param {string} column
 * @param {string} id
 * @param {string} at
 */
async function stamp(table, column, id, at) {
  await db.execute({
    sql: `update ${table} set ${column} = ? where id = ?`,
    args: [at, id],
  });
}

test('a run reads back as a log of what has actually happened', async () => {
  const runId = newId();

  await discovery.insertRun(db, { id: runId, keywords: ['huskies', 'prepping'] });
  await discovery.insertKeywords(db, runId, ['huskies', 'prepping']);
  await discovery.insertCandidates(db, runId, [
    { url: 'https://a.example/', host: 'a.example', keyword: 'huskies' },
    { url: 'https://b.example/', host: 'b.example', keyword: 'huskies' },
    { url: 'https://c.example/', host: 'c.example', keyword: 'prepping' },
  ]);

  const keywords = await discovery.queuedKeywords(db, 10, runId);
  const candidates = await discovery.queuedCandidates(db, 10, runId);
  assert.equal(keywords.length, 2);
  assert.equal(candidates.length, 3);

  const byName = Object.fromEntries(keywords.map((k) => [String(k.keyword), String(k.id)]));
  const byHost = Object.fromEntries(candidates.map((c) => [String(c.host), String(c.id)]));

  await discovery.markKeyword(db, byName.huskies, { status: 'searched', resultCount: 9 });
  await discovery.markKeyword(db, byName.prepping, { status: 'failed', error: 'rate-limited' });
  await discovery.markCandidate(db, byHost['a.example'], {
    status: 'accepted',
    slug: 'a-example',
    score: 90,
  });
  await discovery.markCandidate(db, byHost['b.example'], {
    status: 'rejected',
    reason: ['too-few-items'],
  });
  // c.example is left queued: it has not been checked, so it is not yet news.

  await stamp('discovery_keywords', 'searched_at', byName.huskies, '2026-08-16T18:00:01.000Z');
  await stamp('discovery_candidates', 'checked_at', byHost['a.example'], '2026-08-16T18:00:02.000Z');
  await stamp('discovery_candidates', 'checked_at', byHost['b.example'], '2026-08-16T18:00:03.000Z');
  await stamp('discovery_keywords', 'searched_at', byName.prepping, '2026-08-16T18:00:04.000Z');

  const events = await discovery.eventsForRun(db, runId);

  assert.equal(events.length, 4, 'the unchecked candidate is not an event');
  assert.deepEqual(
    events.map((e) => `${e.kind}:${e.subject}:${e.status}`),
    [
      'keyword:huskies:searched',
      'site:a.example:accepted',
      'site:b.example:rejected',
      'keyword:prepping:failed',
    ],
    'oldest first, keywords and sites interleaved on their own timestamps',
  );

  const [first, accepted, rejected, failed] = events;
  assert.equal(Number(first.amount), 9, 'a searched keyword carries its result count');
  assert.equal(String(accepted.slug), 'a-example', 'an accepted site carries the slug it became');
  assert.equal(Number(accepted.amount), 90, 'and its score');
  assert.equal(String(rejected.detail), '["too-few-items"]', 'a rejection carries its reason');
  assert.equal(String(failed.detail), 'rate-limited', 'a failed keyword carries its error');
});

test('since returns only what happened after it, which is what makes it pollable', async () => {
  const runId = newId();

  await discovery.insertRun(db, { id: runId, keywords: ['kites'] });
  await discovery.insertCandidates(db, runId, [
    { url: 'https://d.example/', host: 'd.example' },
    { url: 'https://e.example/', host: 'e.example' },
  ]);

  const candidates = await discovery.queuedCandidates(db, 10, runId);
  const byHost = Object.fromEntries(candidates.map((c) => [String(c.host), String(c.id)]));

  await discovery.markCandidate(db, byHost['d.example'], { status: 'accepted', slug: 'd' });
  await discovery.markCandidate(db, byHost['e.example'], { status: 'error', reason: 'timeout' });
  await stamp('discovery_candidates', 'checked_at', byHost['d.example'], '2026-08-16T19:00:00.000Z');
  await stamp('discovery_candidates', 'checked_at', byHost['e.example'], '2026-08-16T19:00:05.000Z');

  const all = await discovery.eventsForRun(db, runId);
  assert.equal(all.length, 2);

  const after = await discovery.eventsForRun(db, runId, { since: String(all[0].at) });
  assert.equal(after.length, 1, 'the event used as the cursor is not sent twice');
  assert.equal(String(after[0].subject), 'e.example');

  const caughtUp = await discovery.eventsForRun(db, runId, { since: String(all[1].at) });
  assert.equal(caughtUp.length, 0, 'a caught-up watcher gets nothing, not the history again');

  const other = await discovery.eventsForRun(db, newId());
  assert.equal(other.length, 0, 'events never leak across runs');
});

test('tail returns the newest lines, still oldest-first', async () => {
  const runId = newId();

  await discovery.insertRun(db, { id: runId, keywords: [] });
  await discovery.insertCandidates(
    db,
    runId,
    Array.from({ length: 5 }, (_, i) => ({
      url: `https://t${i}.example/`,
      host: `t${i}.example`,
    })),
  );

  const candidates = await discovery.queuedCandidates(db, 10, runId);
  const byHost = Object.fromEntries(candidates.map((c) => [String(c.host), String(c.id)]));

  for (let i = 0; i < 5; i += 1) {
    await discovery.markCandidate(db, byHost[`t${i}.example`], { status: 'accepted', slug: `t${i}` });
    await stamp(
      'discovery_candidates',
      'checked_at',
      byHost[`t${i}.example`],
      `2026-08-16T21:00:0${i}.000Z`,
    );
  }

  const head = await discovery.eventsForRun(db, runId, { limit: 2 });
  assert.deepEqual(
    head.map((e) => String(e.subject)),
    ['t0.example', 't1.example'],
    'without tail, a limit takes the oldest',
  );

  const tail = await discovery.eventsForRun(db, runId, { limit: 2, tail: true });
  assert.deepEqual(
    tail.map((e) => String(e.subject)),
    ['t3.example', 't4.example'],
    'with tail, the same limit takes the newest — and still reads oldest-first',
  );

  // The cursor a page would hand the stream is the last line it rendered, and
  // asking from there must return nothing when it is already the newest.
  const after = await discovery.eventsForRun(db, runId, { since: String(tail.at(-1).at) });
  assert.equal(after.length, 0);
});

test('a submission reads back as a log of the feeds the crawler settled', async () => {
  const submissionId = newId();
  const now = nowIso();

  await q.insertFeedsBulk(db, [
    { slug: 's-one', feed_url: 'https://one.example/f', title: 'One', next_fetch_at: now, submission_id: submissionId },
    { slug: 's-two', feed_url: 'https://two.example/f', title: 'Two', next_fetch_at: now, submission_id: submissionId },
    { slug: 's-three', feed_url: 'https://three.example/f', title: 'Three', next_fetch_at: now, submission_id: submissionId },
    // Another submission's feed, to prove the log is scoped.
    { slug: 's-other', feed_url: 'https://other.example/f', title: 'Other', next_fetch_at: now, submission_id: newId() },
  ]);

  await db.execute({
    sql: `update feeds set status = 'active', item_count = 12, last_fetched_at = ?
          where slug = 's-one'`,
    args: ['2026-08-16T20:00:01.000Z'],
  });
  await db.execute({
    sql: `update feeds set status = 'error', last_error = 'timeout', last_fetched_at = ?
          where slug = 's-two'`,
    args: ['2026-08-16T20:00:02.000Z'],
  });
  // s-three stays pending with no last_fetched_at.

  const events = await q.submissionEvents(db, submissionId);

  assert.equal(events.length, 2, 'a feed the crawler has not reached yet is not an event');
  assert.deepEqual(
    events.map((e) => `${e.slug}:${e.status}`),
    ['s-one:active', 's-two:error'],
    'oldest first',
  );
  assert.equal(Number(events[0].item_count), 12);
  assert.equal(String(events[1].last_error), 'timeout');

  const after = await q.submissionEvents(db, submissionId, { since: String(events[0].at) });
  assert.equal(after.length, 1);
  assert.equal(String(after[0].slug), 's-two');

  const progress = await q.submissionProgress(db, submissionId);
  // `pending` counts entries handed over but not yet queued, which is zero for
  // a submission whose feeds were written directly.
  assert.deepEqual(progress, { queued: 3, crawled: 1, failed: 1, waiting: 1, pending: 0 });
});
