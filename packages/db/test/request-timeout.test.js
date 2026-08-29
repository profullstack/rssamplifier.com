import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withTimeout } from '../src/client.js';

/**
 * These cover the one code path the rest of the suite cannot reach: every test
 * elsewhere connects to a `file:` database, which never goes near `fetch`. A
 * mistake in here would be invisible until it took production's database access
 * out entirely.
 */

/**
 * A `fetch` that never answers, and rejects when the request is abandoned.
 *
 * Two things a naive stub gets wrong, both of which cost a CI run to find.
 *
 * **It has to keep the process alive.** `AbortSignal.timeout()` schedules an
 * *unref'd* timer — by design, so a pending deadline never holds a program
 * open — and a stub that merely returns a promise gives the event loop nothing
 * else to do. The loop drains, and the test runner reports "Promise resolution
 * is still pending but the event loop has already resolved" and cancels the
 * whole file. In production this cannot happen, because a real in-flight fetch
 * holds a socket open; only a stub that does literally nothing is exposed to
 * it. Node 24's runner happens to keep the loop alive and Node 22's does not,
 * which is why this passed locally and failed in CI on the same commit.
 *
 * **It has to honour a signal that has already fired.** A real fetch handed an
 * aborted signal rejects at once; an `abort` listener added afterwards hears
 * nothing, because the event has been and gone.
 *
 * @param {(reason: unknown) => Error|unknown} [reasonFor] what to reject with
 * @returns {(input: unknown, init?: { signal?: AbortSignal }) => Promise<never>}
 */
function neverAnswers(reasonFor = (reason) => reason) {
  return (_input, init = {}) =>
    new Promise((_resolve, reject) => {
      const { signal } = init;
      // Deliberately ref'd, and cleared on every exit below so it cannot outlive
      // the request it is standing in for.
      const inFlight = setTimeout(() => {}, 30_000);
      const abandon = (reason) => {
        clearTimeout(inFlight);
        reject(reasonFor(reason));
      };

      // `withTimeout` always supplies one; a stub left pending with nothing to
      // wake it would wedge the file for thirty seconds rather than fail.
      if (!signal) {
        clearTimeout(inFlight);
        return;
      }
      if (signal.aborted) {
        abandon(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => abandon(signal.reason));
    });
}

test('a request that outlives its deadline is abandoned', async () => {
  // The reason this exists. undici's default is five minutes, and five minutes
  // is not a timeout -- it is a promise that one wedged request will hold a
  // crawl worker for the rest of the tick. Measured after write serialisation
  // landed: per-feed p50 was 5.3s while p90 was 301s, and the p90 was entirely
  // that ceiling.
  const fetching = withTimeout(30);
  const original = globalThis.fetch;

  globalThis.fetch = neverAnswers();

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

  globalThis.fetch = neverAnswers(() => new Error('aborted by caller'));

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
