import test from 'node:test';
import assert from 'node:assert/strict';

import { withPageSlot, pageSlots, reset } from '../src/lib/pageGate.js';

/**
 * A pass that stays running until the test lets it finish.
 *
 * The gate is only interesting while something is in flight, and an `async`
 * function that returns immediately is never in flight from the caller's point
 * of view — so every test here holds its passes open deliberately.
 *
 * @returns {{ pass: () => Promise<string>, release: () => void, started: Promise<void> }}
 */
function held() {
  let release = () => {};
  let started = () => {};
  const startedPromise = new Promise((r) => {
    started = () => r(undefined);
  });
  const gate = new Promise((r) => {
    release = () => r('done');
  });

  return {
    pass: async () => {
      started();
      return gate;
    },
    release: () => release(),
    started: startedPromise,
  };
}

test('a pass runs when there is room, and frees its slot afterwards', async () => {
  reset();

  const result = await withPageSlot(
    async () => 'read',
    () => 'busy',
  );

  assert.equal(result, 'read');
  assert.equal(pageSlots().active, 0);
});

test('the gate refuses once it is full, and never runs the pass', async () => {
  reset();

  const { limit } = pageSlots();
  const holders = [];

  for (let i = 0; i < limit; i += 1) {
    const h = held();
    holders.push(h);
    void withPageSlot(h.pass, () => 'busy');
    await h.started;
  }

  assert.equal(pageSlots().active, limit);

  // The one that arrives to a full gate. `ran` must stay false: the whole point
  // is that the expensive work does not start, not that it starts and is
  // discarded.
  let ran = false;
  const refused = await withPageSlot(
    async () => {
      ran = true;
      return 'read';
    },
    () => 'busy',
  );

  assert.equal(refused, 'busy');
  assert.equal(ran, false);

  for (const h of holders) h.release();
});

test('a slot is released even when the pass throws', async () => {
  reset();

  await assert.rejects(
    withPageSlot(
      async () => {
        throw new Error('origin fell over');
      },
      () => 'busy',
    ),
    /origin fell over/,
  );

  // The failure mode this guards against is a gate that leaks a slot per bad
  // origin and closes permanently — which would turn a run of dead publishers
  // into the outage the gate exists to prevent.
  assert.equal(pageSlots().active, 0);
});

test('room comes back as passes finish', async () => {
  reset();

  const { limit } = pageSlots();
  const holders = [];

  for (let i = 0; i < limit; i += 1) {
    const h = held();
    holders.push(h);
    void withPageSlot(h.pass, () => 'busy');
    await h.started;
  }

  assert.equal(
    await withPageSlot(
      async () => 'read',
      () => 'busy',
    ),
    'busy',
  );

  holders[0].release();
  // Let the released pass settle so its `finally` has run.
  await new Promise((r) => setImmediate(r));

  assert.equal(
    await withPageSlot(
      async () => 'read',
      () => 'busy',
    ),
    'read',
  );

  for (const h of holders) h.release();
});
