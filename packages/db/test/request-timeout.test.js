import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withTimeout } from '../src/client.js';

/**
 * These cover the one code path the rest of the suite cannot reach: every test
 * elsewhere connects to a `file:` database, which never goes near `fetch`. A
 * mistake in here would be invisible until it took production's database access
 * out entirely.
 */

test('a request that outlives its deadline is abandoned', async () => {
  // The reason this exists. undici's default is five minutes, and five minutes
  // is not a timeout -- it is a promise that one wedged request will hold a
  // crawl worker for the rest of the tick. Measured after write serialisation
  // landed: per-feed p50 was 5.3s while p90 was 301s, and the p90 was entirely
  // that ceiling.
  const fetching = withTimeout(30);
  const original = globalThis.fetch;

  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });

  try {
    await assert.rejects(
      () => fetching('https://example.invalid/', {}),
      (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError',
      'the deadline fires',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a request that finishes in time is untouched', async () => {
  const fetching = withTimeout(5_000);
  const original = globalThis.fetch;
  globalThis.fetch = async () => 'the response';

  try {
    assert.equal(await fetching('https://example.invalid/', {}), 'the response');
  } finally {
    globalThis.fetch = original;
  }
});

test("a caller's own signal still wins if it fires first", async () => {
  // The deadline must not quietly extend the life of a request that something
  // else has already given up on.
  const fetching = withTimeout(60_000);
  const original = globalThis.fetch;
  const controller = new AbortController();

  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
    });

  try {
    const pending = fetching('https://example.invalid/', { signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, /aborted by caller/);
  } finally {
    globalThis.fetch = original;
  }
});

test('calling with no init at all does not throw', async () => {
  // libSQL calls fetch in more than one shape; a missing `init` must not become
  // a TypeError on the way to the database.
  const fetching = withTimeout(5_000);
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => (init?.signal ? 'has a signal' : 'no signal');

  try {
    assert.equal(await fetching('https://example.invalid/'), 'has a signal');
  } finally {
    globalThis.fetch = original;
  }
});
