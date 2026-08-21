import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

import { remember, primeCache, resetCacheState } from '../src/cache.js';

/**
 * A Redis stand-in.
 *
 * Only `get` and `set` are used, and only the `PX` form of `set` -- keeping it
 * this small is deliberate, because a fake that drifts from the real client is
 * worse than none. Expiry is modelled because "the key vanished" is a state the
 * cache has to survive, and it is the one ioredis behaviour these tests depend
 * on beyond plain storage.
 */
function fakeRedis() {
  const store = new Map();
  return {
    store,
    calls: { get: 0, set: 0 },
    async get(k) {
      this.calls.get += 1;
      const hit = store.get(k);
      if (!hit) return null;
      if (hit.until <= Date.now()) { store.delete(k); return null; }
      return hit.body;
    },
    async set(k, body, _px, ms) {
      this.calls.set += 1;
      store.set(k, { body, until: Date.now() + Number(ms) });
      return 'OK';
    },
  };
}

/** Rewrite a stored entry's timestamp, to age it without waiting. */
function age(client, key, ms) {
  const full = `rsa:stats:${key}`;
  const hit = client.store.get(full);
  const parsed = JSON.parse(hit.body);
  parsed.at -= ms;
  client.store.set(full, { ...hit, body: JSON.stringify(parsed) });
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => resetCacheState());

test('a miss computes, stores, and returns', async () => {
  const client = fakeRedis();
  let ran = 0;

  const got = await remember('k', { ttlMs: 1000, client }, async () => { ran += 1; return { n: 1 }; });

  assert.deepEqual(got, { n: 1 });
  assert.equal(ran, 1);
  assert.equal(client.calls.set, 1, 'the value was stored');
});

test('a fresh hit does not run the computation at all', async () => {
  const client = fakeRedis();
  let ran = 0;
  const compute = async () => { ran += 1; return { n: ran }; };

  await remember('k', { ttlMs: 60_000, client }, compute);
  const second = await remember('k', { ttlMs: 60_000, client }, compute);

  assert.equal(ran, 1, 'the second read was served from the cache');
  assert.deepEqual(second, { n: 1 });
});

test('a stale hit answers immediately and refreshes behind the reader', async () => {
  const client = fakeRedis();
  let ran = 0;

  await remember('k', { ttlMs: 100, client }, async () => { ran += 1; return { n: 1 }; });
  age(client, 'k', 5_000); // now well past ttl, well inside maxStale

  // The point of the whole module: the caller gets the old value now, not in
  // however long the recomputation takes.
  const got = await remember('k', { ttlMs: 100, maxStaleMs: 60_000, client }, async () => {
    ran += 1;
    await new Promise((r) => setTimeout(r, 50));
    return { n: 2 };
  });

  assert.deepEqual(got, { n: 1 }, 'served stale rather than waiting');
  // Longer than the 50ms the refresh itself takes: the point being asserted is
  // that it lands eventually, not that it lands within one tick.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ran, 2, 'and the refresh did run');

  const after = await remember('k', { ttlMs: 100, maxStaleMs: 60_000, client }, async () => ({ n: 99 }));
  assert.deepEqual(after, { n: 2 }, 'the refreshed value replaced it');
});

test('a computation that never succeeds still serves the last good answer', async () => {
  // This is production's `categoryStats`: it does not run slowly, it fails. A
  // plain cache stores nothing and every request pays the full timeout for
  // ever. One success has to be enough.
  const client = fakeRedis();

  await remember('cat', { ttlMs: 10, client }, async () => ({ blogs: 7 }));
  age(client, 'cat', 10 * 60 * 1000);

  for (let i = 0; i < 3; i++) {
    const got = await remember('cat', { ttlMs: 10, maxStaleMs: 60 * 60 * 1000, client }, async () => {
      throw new Error('SQLITE timeout');
    });
    assert.deepEqual(got, { blogs: 7 }, 'the stale answer survives a failing refresh');
    await settle();
  }
});

test('a value past maxStale is still returned when it cannot be recomputed', async () => {
  const client = fakeRedis();
  await remember('cat', { ttlMs: 10, client }, async () => ({ blogs: 7 }));
  age(client, 'cat', 48 * 60 * 60 * 1000); // older than maxStale

  const got = await remember('cat', { ttlMs: 10, maxStaleMs: 60_000, client }, async () => {
    throw new Error('still down');
  });

  assert.deepEqual(got, { blogs: 7 }, 'a very old answer beats no answer');
});

test('a slow computation is abandoned at the timeout rather than held', async () => {
  const client = fakeRedis();
  const started = Date.now();

  const got = await remember('slow', { ttlMs: 1000, timeoutMs: 60, fallback: null, client }, async () => {
    await new Promise((r) => setTimeout(r, 5_000));
    return 'too late';
  });

  assert.equal(got, null, 'gave up and returned the fallback');
  assert.ok(Date.now() - started < 2_000, `returned promptly, took ${Date.now() - started}ms`);
});

test('concurrent stale reads start only one refresh', async () => {
  const client = fakeRedis();
  let ran = 0;

  await remember('k', { ttlMs: 10, client }, async () => { ran += 1; return 1; });
  age(client, 'k', 5_000);

  const compute = async () => { ran += 1; await new Promise((r) => setTimeout(r, 40)); return 2; };
  await Promise.all(
    Array.from({ length: 5 }, () => remember('k', { ttlMs: 10, maxStaleMs: 60_000, client }, compute)),
  );
  await settle();

  assert.equal(ran, 2, 'one initial fill plus exactly one refresh, not five');
});

test('with no client configured it behaves exactly like the uncached read', async () => {
  let ran = 0;
  const compute = async () => { ran += 1; return { n: ran }; };

  assert.deepEqual(await remember('k', { ttlMs: 60_000, client: null }, compute), { n: 1 });
  assert.deepEqual(await remember('k', { ttlMs: 60_000, client: null }, compute), { n: 2 });
  assert.equal(ran, 2, 'nothing is cached, every call computes');
});

test('a Redis that throws on every command does not fail the read', async () => {
  const broken = {
    async get() { throw new Error('ECONNREFUSED'); },
    async set() { throw new Error('ECONNREFUSED'); },
  };

  const got = await remember('k', { ttlMs: 1000, client: broken }, async () => ({ ok: true }));
  assert.deepEqual(got, { ok: true }, 'the value still came back');
});

test('a Redis that accepts commands and never answers does not stall the read', async () => {
  // The failure mode that would make this module worse than no cache: a socket
  // that is up, so nothing errors, but a GET that never settles. Bounding the
  // lookup is what keeps a Redis outage from becoming the stall it was added
  // to remove.
  const hung = {
    async get() { await new Promise(() => {}); },
    async set() { await new Promise(() => {}); },
  };

  const started = Date.now();
  const got = await remember('k', { ttlMs: 1000, client: hung }, async () => ({ ok: true }));

  assert.deepEqual(got, { ok: true }, 'it fell through to the real read');
  assert.ok(Date.now() - started < 8_000, `did not hang, took ${Date.now() - started}ms`);
});

test('a failed computation with nothing cached returns the fallback, not a throw', async () => {
  const client = fakeRedis();
  const got = await remember('k', { ttlMs: 1000, fallback: {}, client }, async () => {
    throw new Error('nope');
  });
  assert.deepEqual(got, {}, 'callers treat this as "unavailable", so it must not throw');
});

test('a primed value is served to readers without them computing anything', async () => {
  // The warmer's whole contract. `categoryStats` takes ~59s, so no reader can
  // fill this key; a background job fills it and readers must find it there.
  const client = fakeRedis();

  const stored = await primeCache('categoryStats', { total: 476_715 }, { client });
  assert.equal(stored, true);

  let ran = 0;
  const got = await remember('categoryStats', { ttlMs: 5 * 60_000, client }, async () => {
    ran += 1;
    throw new Error('a reader must never have to run this');
  });

  assert.deepEqual(got, { total: 476_715 });
  assert.equal(ran, 0, 'the reader did not touch the database');
});

test('priming without a client is a no-op rather than a crash', async () => {
  // The poller runs with no REDIS_URL locally and in the test suite.
  assert.equal(await primeCache('k', { a: 1 }, { client: null }), false);
});

test('bigint counts survive the round trip', async () => {
  // libSQL hands back BigInt for some aggregates and JSON.stringify throws on
  // it, which would silently disable the cache for exactly the count-heavy
  // reads it exists to serve.
  const client = fakeRedis();
  await remember('k', { ttlMs: 60_000, client }, async () => ({ feeds: 10n }));
  const again = await remember('k', { ttlMs: 60_000, client }, async () => ({ feeds: 0 }));
  assert.deepEqual(again, { feeds: 10 });
});
