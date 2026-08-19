import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crawlFeed, throttleMinutes, backoffMinutes } from '../src/crawl.js';

/**
 * A db stub that records what the crawl decided, without a database.
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

const feed = {
  id: 'feed-1',
  feed_url: 'https://example.substack.com/feed',
  error_count: 3,
  fetch_interval_minutes: 60,
  item_count: 10,
};

test('a throttled feed is rescheduled, not marked broken', async () => {
  // The damage this prevents. `markCrawlFailure` sets status='error', increments
  // error_count and, at ten consecutive failures, marks the feed dead. A rate
  // limit is hit by every feed on one backend at the same moment, so recording
  // 429s as feed health would retire a whole platform for our own crawl rate.
  const db = recorder();
  const resolve = async () => ({ ok: false, error: 'http-429', throttled: true, retryAfter: 120 });

  const result = await crawlFeed(db, feed, { resolve });

  assert.equal(result.ok, false);
  assert.equal(result.throttled, true);

  const sql = db.calls.map((c) => c.sql).join('\n');
  assert.ok(!/error_count/.test(sql), 'must not touch error_count');
  assert.ok(!/status\s*=/.test(sql), 'must not touch status');
  assert.ok(!/last_error/.test(sql), 'must not touch last_error');
  assert.ok(!/last_fetched_at/.test(sql), 'must not claim we read the publisher');
  assert.ok(/next_fetch_at/.test(sql), 'must reschedule');
});

test('an ordinary failure still counts against the feed', async () => {
  // The other half: this guard must not swallow real breakage.
  const db = recorder();
  const resolve = async () => ({ ok: false, error: 'http-404' });

  const result = await crawlFeed(db, feed, { resolve });

  assert.equal(result.ok, false);
  assert.ok(!result.throttled);

  const sql = db.calls.map((c) => c.sql).join('\n');
  assert.ok(/error_count/.test(sql), 'a 404 is evidence about the feed');
});

test('the server’s own Retry-After decides when we come back', () => {
  assert.equal(throttleMinutes(120), 2);
  assert.equal(throttleMinutes(90), 2); // rounded up, never down to zero
  assert.equal(throttleMinutes(30), 1); // floored at a minute
});

test('a throttle that names no interval gets a sane default', () => {
  assert.equal(throttleMinutes(null), 30);
  assert.equal(throttleMinutes(undefined), 30);
  assert.equal(throttleMinutes(0), 30);
  assert.equal(throttleMinutes(-5), 30);
  assert.equal(throttleMinutes('nonsense'), 30);
});

test('a throttle cannot mothball a feed', () => {
  // A misparsed date must not turn into a month-long interval.
  assert.equal(throttleMinutes(86_400 * 30), 1440);
});

test('a throttle is far shorter than the error ladder it replaces', () => {
  // The feed is healthy; it is our rate that is wrong. Coming back in half an
  // hour is right where a fourth consecutive *failure* would wait twelve.
  assert.ok(throttleMinutes(null) < backoffMinutes(4));
});
