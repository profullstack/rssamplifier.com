import assert from 'node:assert/strict';
import { test } from 'node:test';

import { writePath } from '../src/client.js';

/**
 * Which write path a process takes, and whether it says so.
 *
 * The bug this exists for was not a failure. `REDIS_URL` was never set on
 * either production service, so `connect()` silently fell back to the
 * in-process queue while the Redis queue and its folding sat built and
 * dormant. Everything worked; it simply was not the thing everyone believed
 * was running, and nothing said otherwise.
 */

const remote = 'libsql://example.turso.io';

test('a broker and a remote database select the Redis queue', () => {
  const chosen = writePath({ url: remote, redis: 'redis://x:6379', enabled: true });

  assert.equal(chosen.path, 'redis');
  assert.match(chosen.why, /cluster/);
});

test('no REDIS_URL falls back, and says that is why', () => {
  // The exact production state this went unnoticed in, and the line that would
  // have made it obvious.
  const chosen = writePath({ url: remote, redis: undefined, enabled: true });

  assert.equal(chosen.path, 'in-process');
  assert.match(chosen.why, /REDIS_URL/);
});

test('an empty REDIS_URL is treated as absent, not as a broker', () => {
  const chosen = writePath({ url: remote, redis: '', enabled: true });

  assert.equal(chosen.path, 'in-process');
  assert.match(chosen.why, /REDIS_URL/);
});

test('WRITE_QUEUE off is reported as a choice, not as a missing broker', () => {
  const chosen = writePath({ url: remote, redis: 'redis://x:6379', enabled: false });

  assert.equal(chosen.path, 'in-process');
  assert.match(chosen.why, /WRITE_QUEUE/);
});

test('the write worker itself never queues, however it is configured', () => {
  // `queue: false` is the process that drains the queue. Routing it back
  // through the queue would post every job straight back and nothing would
  // ever reach the database.
  const chosen = writePath({ url: remote, redis: 'redis://x:6379', enabled: true, queue: false });

  assert.equal(chosen.path, 'in-process');
  assert.match(chosen.why, /drains/);
});

test('a local file database never reaches for a broker', () => {
  // The test suite and local development. Routing a file: URL through Redis
  // would make the suite depend on one.
  const chosen = writePath({ url: 'file:/tmp/x.db', redis: 'redis://x:6379', enabled: true });

  assert.equal(chosen.path, 'in-process');
  assert.match(chosen.why, /file/);
});

test('every path explains itself', () => {
  // The reason is the point. "in-process" alone does not distinguish a
  // deliberate local run from a production service missing its broker.
  for (const settings of [
    { url: remote, redis: 'redis://x:6379', enabled: true },
    { url: remote, redis: undefined, enabled: true },
    { url: remote, redis: 'redis://x:6379', enabled: false },
    { url: 'file:/tmp/x.db', redis: undefined, enabled: true },
  ]) {
    const chosen = writePath(settings);
    assert.ok(chosen.why && chosen.why.length > 0, `no reason given for ${JSON.stringify(settings)}`);
  }
});
