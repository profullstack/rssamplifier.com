import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  crawlFeed,
  failureMinutes,
  isSlowOrBroken,
  backoffMinutes,
  RECHECK_MINUTES,
  DEAD_AFTER,
} from '../src/crawl.js';

/**
 * Fleet crawler rule (2026-11-08): a slow or broken target -- timeout, DNS, TLS,
 * connection error, 5xx -- is flagged and left alone for thirty days; nothing
 * is dead for ever; 4xx keeps its short ladder.
 */

function recorder() {
  const calls = [];
  return {
    calls,
    execute: async (statement) => {
      calls.push(statement);
      return { rows: [], rowsAffected: 0 };
    },
    batch: async (statements) => {
      calls.push(...statements);
      return statements.map(() => ({ rows: [], rowsAffected: 0 }));
    },
  };
}

const feed = { id: 'feed-1', feed_url: 'https://slow.example/feed', error_count: 0, fetch_interval_minutes: 60 };

test('thirty days, in minutes', () => {
  assert.equal(RECHECK_MINUTES, 43_200);
  assert.equal(DEAD_AFTER, 10);
});

test('slow or broken targets are told apart from refusals', () => {
  for (const e of ['timeout', 'fetch-failed', 'connection-failed', 'tls-failed', 'dns-failed', 'http-500', 'http-503']) {
    assert.equal(isSlowOrBroken(e), true, e);
  }
  for (const e of ['http-404', 'http-410', 'http-403', 'no-feed-found', 'blocked-host', 'dns-retry', 'invalid-url', null, undefined]) {
    assert.equal(isSlowOrBroken(e), false, String(e));
  }
});

test('a slow or broken target waits thirty days from the first failure', () => {
  assert.equal(failureMinutes('timeout', 1), RECHECK_MINUTES);
  assert.equal(failureMinutes('http-502', 1), RECHECK_MINUTES);
  assert.equal(failureMinutes('dns-failed', 3), RECHECK_MINUTES);
});

test('4xx keeps the short ladder until it retires the feed, then monthly rechecks', () => {
  assert.equal(failureMinutes('http-404', 1), backoffMinutes(1));
  assert.equal(failureMinutes('http-410', 5), backoffMinutes(5));
  assert.equal(failureMinutes('http-404', 9), 1440);
  assert.equal(failureMinutes('http-404', DEAD_AFTER), RECHECK_MINUTES, 'dead is a month, not for ever');
  assert.equal(failureMinutes('no-feed-found', 25), RECHECK_MINUTES);
});

test('a crawl that times out records the error and a next check thirty days out', async () => {
  const db = recorder();
  const res = await crawlFeed(db, feed, { resolve: async () => ({ ok: false, error: 'timeout' }) });
  assert.equal(res.ok, false);
  assert.equal(res.recheckDays, 30);

  const call = db.calls.find((c) => /last_error/.test(c.sql));
  assert.ok(call, 'markCrawlFailure ran');
  const [status, , error, count, interval, next] = call.args;
  assert.equal(status, 'error');
  assert.equal(error, 'timeout');
  assert.equal(count, 1);
  assert.equal(interval, null, 'the feed keeps its own interval');
  const days = (Date.parse(next) - Date.now()) / 86_400_000;
  assert.ok(days > 29.99 && days <= 30, `30 days -> ${days}`);
});

test('a 404 still walks the ladder and stores it as the interval', async () => {
  const db = recorder();
  await crawlFeed(db, feed, { resolve: async () => ({ ok: false, error: 'http-404' }) });
  const call = db.calls.find((c) => /last_error/.test(c.sql));
  const [, , , , interval, next] = call.args;
  assert.equal(interval, 60);
  const minutes = (Date.parse(next) - Date.now()) / 60_000;
  assert.ok(minutes > 59 && minutes <= 60);
});

test('a 429 is still a throttle, capped at a day, never a flag', async () => {
  const db = recorder();
  const res = await crawlFeed(db, feed, {
    resolve: async () => ({ ok: false, error: 'http-429', throttled: true, retryAfter: 90 * 86_400 }),
  });
  assert.equal(res.throttled, true);
  const sql = db.calls.map((c) => c.sql).join('\n');
  assert.ok(!/last_error/.test(sql));
  const next = db.calls[0].args[0];
  const hours = (Date.parse(next) - Date.now()) / 3_600_000;
  assert.ok(hours > 23.9 && hours <= 24, `capped at a day -> ${hours}`);
});
